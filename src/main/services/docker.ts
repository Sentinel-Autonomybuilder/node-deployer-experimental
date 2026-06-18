import Docker from 'dockerode';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { log } from './logger';
import { getSettings } from './settings';

/**
 * Inlined Dockerfile for the sentinel-dvpnx node runtime.
 *
 * Upstream publishes **no release binaries**, so we build from source —
 * mirroring the canonical Dockerfile in sentinel-official/sentinel-dvpnx
 * and sentinel-official/sentinelhub. The final image carries:
 *
 *   /usr/local/bin/dvpnx        — sentinel-dvpnx node daemon
 *   /usr/local/bin/sentinelhub  — Sentinel chain CLI (for key mgmt + tx)
 *
 * First build takes 5–15 minutes on a fresh machine; subsequent deploys
 * reuse the cached image.
 */
export const SENTINEL_DVPNX_DOCKERFILE = `ARG DVPNX_REF=v8.3.1
ARG HUB_REF=v12.0.2

# Go 1.24 is the version sentinel-dvpnx pins in go.mod. We pin explicitly
# with GOTOOLCHAIN=local so Go doesn't silently upgrade to 1.26 (which
# breaks bytedance/sonic's runtime internal hooks).

# ---------- sentinel-dvpnx build -------------------------------------------
FROM golang:1.24-alpine3.21 AS build-dvpnx
ENV GOTOOLCHAIN=local
ARG DVPNX_REF
WORKDIR /src
RUN apk add --no-cache --no-scripts autoconf automake bash file g++ gcc git libtool \\
    linux-headers make musl-dev unbound-dev && apk fix 2>/dev/null || true
RUN git clone --branch=\${DVPNX_REF} --depth=1 https://github.com/sentinel-official/sentinel-dvpnx.git .
RUN make --jobs=$(nproc) install

# ---------- sentinelhub build ----------------------------------------------
FROM golang:1.24-alpine3.21 AS build-hub
ENV GOTOOLCHAIN=local
ARG HUB_REF
WORKDIR /src
RUN apk add --no-cache --no-scripts build-base ca-certificates git linux-headers wget && apk fix 2>/dev/null || true
RUN git clone --branch=\${HUB_REF} --depth=1 https://github.com/sentinel-official/sentinelhub.git .
RUN ARCH=$(uname -m) && \\
    WASM_VERSION=$(go list -m all | grep github.com/CosmWasm/wasmvm | awk '{print $NF}') && \\
    echo "downloading libwasmvm_muslc.\${ARCH}.a @ \${WASM_VERSION}" && \\
    wget -q -O /usr/local/lib/libwasmvm_muslc.a \\
        "https://github.com/CosmWasm/wasmvm/releases/download/\${WASM_VERSION}/libwasmvm_muslc.\${ARCH}.a"
RUN STATIC=true make --jobs=$(nproc) build

# ---------- runtime --------------------------------------------------------
FROM alpine:3.21
# --no-scripts + apk fix fallback: on some hosts (notably Debian 12 with
# older kernels), Alpine's busybox trigger fails at post-install on newer
# package versions. Skipping scripts during add and calling apk fix
# afterwards is the recommended workaround from alpinelinux-discuss.
RUN apk add --no-cache --no-scripts bash ca-certificates iptables openvpn unbound-libs \\
    v2ray wireguard-tools && \\
    (apk fix 2>/dev/null || true) && \\
    rm -rf /etc/v2ray/ /usr/share/v2ray/
COPY --from=build-dvpnx /go/bin/sentinel-dvpnx /usr/local/bin/dvpnx
COPY --from=build-hub   /src/bin/sentinelhub   /usr/local/bin/sentinelhub
VOLUME ["/root/.sentinel-dvpnx"]
EXPOSE 7777/udp 7777/tcp
ENTRYPOINT ["dvpnx"]
CMD ["start"]
`;

/**
 * Docker daemon control.
 *
 * On macOS / Windows the app communicates with Docker Desktop via its
 * Unix socket (macOS) or named pipe (Windows). On Linux it's the system
 * socket at /var/run/docker.sock. The Settings `dockerSocket` lets the
 * user override (useful for Podman, colima, or rootless setups).
 *
 * We only ever read/write under /root/.sentinel-dvpnx inside the
 * container; the host mount is userData/nodes/<nodeId>.
 */

export const IMAGE_TAG = 'sentinel-dvpn-app/sentinel-dvpnx:v8.3.1';
export const IMAGE_VERSION = 'v8.3.1';

let client: Docker | null = null;

function candidateSockets(override: string): string[] {
  if (override) return [override];
  if (process.platform === 'win32') {
    // Docker Desktop on Windows exposes different named pipes depending on
    // which context is active. `desktop-linux` (the default since 4.x) uses
    // `dockerDesktopLinuxEngine`; the legacy `default` context uses
    // `docker_engine`; Windows-containers mode uses `dockerDesktopWindowsEngine`.
    // Probe all three so a freshly-installed Docker Desktop works out of the box.
    return [
      '//./pipe/dockerDesktopLinuxEngine',
      '//./pipe/docker_engine',
      '//./pipe/dockerDesktopWindowsEngine',
      '//./pipe/podman-machine-default',
    ];
  }
  return [
    '/var/run/docker.sock',
    `${os.homedir()}/.docker/run/docker.sock`,      // Docker Desktop on macOS (new)
    `${os.homedir()}/.docker/desktop/docker.sock`,  // Docker Desktop on macOS (older)
    `${os.homedir()}/.colima/default/docker.sock`,  // Colima
    `${os.homedir()}/.colima/docker.sock`,
    `${os.homedir()}/.rd/docker.sock`,              // Rancher Desktop
    `/run/user/${process.getuid?.() ?? 1000}/docker.sock`, // rootless Linux
    `/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`, // rootless Podman
  ];
}

export async function getClient(): Promise<Docker> {
  if (client) return client;
  const settings = await getSettings();
  const candidates = candidateSockets(settings.dockerSocket);
  for (const sock of candidates) {
    try {
      const isPipe = sock.startsWith('//');
      const c = isPipe ? new Docker({ socketPath: sock }) : new Docker({ socketPath: sock });
      // ping forces a real handshake with the daemon
      await c.ping();
      client = c;
      log.info('docker connected', { socket: sock });
      return c;
    } catch (err) {
      log.debug('docker socket probe failed', { sock, err: (err as Error).message });
    }
  }
  // Build a user-actionable error that reflects what's actually missing:
  // Docker Desktop not installed, installed-but-not-running, or a Linux
  // daemon that isn't up. Renderer keys off `reason` to pick the right UI.
  const desktop = await detectDockerDesktop();
  const err = new Error(
    desktop.installed
      ? 'Docker Desktop is installed but not running. Start Docker Desktop and try again.'
      : process.platform === 'linux'
        ? 'Could not reach the Docker daemon. Start the Docker Engine (`sudo systemctl start docker`) and try again.'
        : 'Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/ and try again.',
  ) as Error & { reason?: DockerUnreachableReason; desktop?: DockerDesktopStatus };
  err.reason = desktop.installed
    ? 'desktop-not-running'
    : process.platform === 'linux'
      ? 'engine-not-running'
      : 'desktop-not-installed';
  err.desktop = desktop;
  throw err;
}

/** Structured reason so the renderer can render the right recovery UI. */
export type DockerUnreachableReason =
  | 'desktop-not-installed'
  | 'desktop-not-running'
  | 'engine-not-running';

export interface DockerDesktopStatus {
  /** Docker Desktop is installed on disk (Windows/macOS). Always false on Linux. */
  installed: boolean;
  /** Absolute path to the launcher, if installed. */
  launchPath?: string;
  /** True if we can start it from the app (Windows/macOS only). */
  startable: boolean;
}

export interface DockerHealth {
  reachable: boolean;
  version?: string;
  error?: string;
  socket?: string;
  /** Why the daemon isn't reachable, if !reachable. */
  reason?: DockerUnreachableReason;
  /** Install/launch state for Docker Desktop (Windows/macOS). */
  desktop?: DockerDesktopStatus;
}

export async function dockerHealth(): Promise<DockerHealth> {
  try {
    const c = await getClient();
    const info = await withDockerTimeout(() => c.version(), 5_000, 'version');
    return { reachable: true, version: info.Version };
  } catch (err) {
    const e = err as Error & { reason?: DockerUnreachableReason; desktop?: DockerDesktopStatus };
    // If getClient() already attached reason+desktop, reuse them.
    // Otherwise (unexpected error), probe once so the UI still gets useful info.
    const desktop = e.desktop ?? (await detectDockerDesktop());
    const reason =
      e.reason ??
      (desktop.installed
        ? 'desktop-not-running'
        : process.platform === 'linux'
          ? 'engine-not-running'
          : 'desktop-not-installed');
    return { reachable: false, error: e.message, reason, desktop };
  }
}

/**
 * Where Docker Desktop's launcher lives on each host OS.
 *
 * On Windows it's normally installed system-wide, but users with
 * non-admin installs may have it under %LOCALAPPDATA%. On macOS it ships
 * as a single .app under /Applications. Linux has no "Docker Desktop" as
 * a separate launchable — the daemon is a systemd unit.
 */
function dockerDesktopCandidatePaths(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const localAppData =
      process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'),
      path.join(localAppData, 'Docker', 'Docker Desktop.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Docker.app/Contents/MacOS/Docker Desktop'];
  }
  return [];
}

/** Detect whether Docker Desktop is installed on disk (Windows/macOS). */
export async function detectDockerDesktop(): Promise<DockerDesktopStatus> {
  if (process.platform === 'linux') {
    return { installed: false, startable: false };
  }
  for (const candidate of dockerDesktopCandidatePaths()) {
    try {
      await fs.access(candidate);
      return { installed: true, launchPath: candidate, startable: true };
    } catch {
      /* not at this path — keep probing */
    }
  }
  return { installed: false, startable: false };
}

/**
 * Try to start Docker Desktop. Returns `{ started: true }` if the
 * launcher was spawned; the caller still has to poll `dockerHealth()`
 * because Docker Desktop takes 10–30 s to bring its VM up. Never throws
 * on Linux or when Docker Desktop isn't installed — returns `started:false`.
 */
export async function startDockerDesktop(): Promise<{
  started: boolean;
  launchPath?: string;
  error?: string;
}> {
  const status = await detectDockerDesktop();
  if (!status.installed || !status.launchPath) {
    return { started: false, error: 'Docker Desktop is not installed' };
  }
  try {
    // `detached: true` + immediate `unref()` lets Docker Desktop survive
    // our app quitting, and avoids Electron waiting on the child handle.
    // `shell: false` + exact path is safe (no user input interpolated).
    const child = spawn(status.launchPath, [], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.unref();
    log.info('docker desktop launch requested', { launchPath: status.launchPath });
    return { started: true, launchPath: status.launchPath };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn('docker desktop launch failed', { err: msg });
    return { started: false, launchPath: status.launchPath, error: msg };
  }
}

/**
 * Reset the cached Docker client so the next call re-probes sockets.
 * Call this after `startDockerDesktop()` so once the daemon comes up,
 * `dockerHealth()` picks up the new socket on the next poll.
 */
export function resetDockerClient(): void {
  client = null;
}

// ---------------------------------------------------------------------------
// Image lifecycle
// ---------------------------------------------------------------------------

export async function hasImage(tag: string): Promise<boolean> {
  const c = await getClient();
  try {
    const img = c.getImage(tag);
    await img.inspect();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the sentinel-dvpnx image if we don't already have it locally.
 * Streams build output via the `onLog` callback.
 *
 * The Dockerfile is embedded in this file as a string — we materialize it
 * to a short-lived temp directory so dockerode can use it as a build
 * context. That avoids any runtime path resolution across dev vs packaged.
 */
export async function ensureImage(
  tag: string,
  onLog: (line: string) => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (await hasImage(tag)) return;
  if (signal?.aborted) throw new Error('Image build aborted before start');
  const c = await getClient();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-dvpnx-build-'));
  const dockerfilePath = path.join(tmpDir, 'Dockerfile');
  await fs.writeFile(dockerfilePath, SENTINEL_DVPNX_DOCKERFILE, 'utf8');
  onLog(`[docker] building ${tag} (context=${tmpDir})`);

  try {
    const stream = await c.buildImage(
      { context: tmpDir, src: ['Dockerfile'] },
      {
        t: tag,
        dockerfile: 'Dockerfile',
        buildargs: { SENTINEL_DVPNX_VERSION: IMAGE_VERSION },
        // Pin the daemon to the classic builder. On Docker Desktop 23+ the
        // default `POST /build` endpoint is routed through BuildKit, which
        // caches the OCI artifact in its own store without tagging the
        // local image store — so the build "succeeds" but
        // `docker.getImage(tag).inspect()` returns 404. BuildKit only
        // writes to the image store when the caller negotiates a gRPC
        // session with an `exporter=docker` output, which dockerode does
        // not do. Forcing `version: 1` keeps us on the classic builder
        // where tagging is implicit.
        version: '1',
      } as Docker.ImageBuildOptions & { version?: '1' | '2' },
    );

    // Hard ceiling so a wedged BuildKit doesn't hang the deploy forever.
    // 15 minutes is enough for a cold build on slow networks; a healthy
    // build on a warm cache finishes in well under a minute. If we hit
    // this we tear down the build stream so dockerode releases the pipe.
    const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
    let buildTimer: NodeJS.Timeout | null = null;
    let abortHandler: (() => void) | null = null;
    await new Promise<void>((resolve, reject) => {
      const destroyStream = (err: Error) => {
        try {
          (stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void }).destroy?.(err);
        } catch {
          /* ignore */
        }
      };
      buildTimer = setTimeout(() => {
        destroyStream(new Error('build timeout'));
        reject(
          new Error(
            `Image build of ${tag} timed out after ${BUILD_TIMEOUT_MS / 60_000} minutes. ` +
              `BuildKit may be wedged — restart Docker Desktop and try again.`,
          ),
        );
      }, BUILD_TIMEOUT_MS);
      if (signal) {
        abortHandler = () => {
          onLog('[docker] build aborted by user — tearing down stream');
          destroyStream(new Error('build aborted'));
          reject(new Error('Image build aborted'));
        };
        if (signal.aborted) {
          abortHandler();
        } else {
          signal.addEventListener('abort', abortHandler, { once: true });
        }
      }
      c.modem.followProgress(
        stream,
        (err) => {
          if (buildTimer) clearTimeout(buildTimer);
          if (abortHandler && signal) signal.removeEventListener('abort', abortHandler);
          err ? reject(err) : resolve();
        },
        (evt: { stream?: string; error?: string }) => {
          if (evt.error) onLog(`[docker] ${evt.error}`);
          if (evt.stream) {
            for (const line of evt.stream.split(/\r?\n/)) {
              if (line.trim()) onLog(`[docker] ${line.trim()}`);
            }
          }
        },
      );
    });

    // Belt-and-braces: even with `version: 1`, some Docker Desktop setups
    // have `features.buildkit: true` in daemon.json which overrides the
    // query param on older engines. If the image is still not in the
    // local store after a "successful" build, fail loudly with an
    // actionable message instead of letting the next step 404.
    if (!(await hasImage(tag))) {
      throw new Error(
        `Build of ${tag} reported success but the image is not in the ` +
          `local store. This usually means BuildKit silently cached the ` +
          `artifact without tagging it. Try disabling BuildKit in Docker ` +
          `Desktop Settings → Docker Engine (set "features.buildkit" to false ` +
          `and restart), or run "docker buildx build --load" manually.`,
      );
    }
    onLog(`[docker] image ${tag} built`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
      // Windows: Docker Engine occasionally keeps a handle on the build
      // context for a few seconds. The temp dir is in os.tmpdir() so the OS
      // will sweep it eventually — log a warning so leaks are visible.
      log.warn('docker build temp cleanup failed', { tmpDir, err: String(err) });
    });
  }
}

// ---------------------------------------------------------------------------
// Container lifecycle for sentinel-dvpnx nodes
// ---------------------------------------------------------------------------

/**
 * Race a promise against a hard timeout. On Windows + Docker Desktop the
 * named-pipe transport occasionally wedges mid-call (a half-open response
 * after a Desktop background restart, OS update, or WSL2 hiccup). Without
 * an outer ceiling, dockerode just sits on the hung pipe forever and the
 * deploy stalls at "Starting node container" or "Preparing node image".
 * Every long-running primitive (start/stop/remove/create) goes through
 * here so the deploy fails with a specific, actionable message instead.
 */
export async function withDockerTimeout<T>(
  op: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Docker operation '${label}' timed out after ${Math.round(ms / 1000)}s. ` +
            `The daemon may be wedged — restart Docker Desktop and try again.`,
        ),
      );
    }, ms);
    op().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface RunNodeOptions {
  nodeId: string;
  hostDataDir: string; // mounted to /root/.sentinel-dvpnx
  port: number;
  imageTag: string;
  /** Arguments passed to the sentinel-dvpnx entrypoint. */
  cmd?: string[];
}

export function containerName(nodeId: string): string {
  return `sentinel-dvpn-${nodeId.slice(0, 12)}`;
}

export async function runNode(opts: RunNodeOptions): Promise<string> {
  const c = await getClient();
  const name = containerName(opts.nodeId);

  // Remove any previous container with the same name (stale from a prior
  // deploy). Each step gets its own timeout — a hung daemon can wedge any
  // of inspect/stop/remove independently, and a redeploy that sits forever
  // on cleanup is the worst kind of failure (no error to act on).
  try {
    const existing = c.getContainer(name);
    await withDockerTimeout(() => existing.inspect(), 15_000, 'inspect previous container');
    try {
      await withDockerTimeout(() => existing.stop(), 30_000, 'stop previous container');
    } catch {
      /* not running */
    }
    await withDockerTimeout(() => existing.remove(), 15_000, 'remove previous container');
  } catch {
    /* none exists */
  }

  await fs.mkdir(opts.hostDataDir, { recursive: true });

  const container = await withDockerTimeout(
    () =>
      c.createContainer({
        name,
        Image: opts.imageTag,
        Cmd: opts.cmd ?? ['start'],
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        HostConfig: {
          RestartPolicy: { Name: 'unless-stopped' },
          Binds: [`${opts.hostDataDir}:/root/.sentinel-dvpnx`],
          CapAdd: ['NET_ADMIN', 'NET_RAW'],
          CapDrop: ['ALL'],
          Devices: [
            {
              PathOnHost: '/dev/net/tun',
              PathInContainer: '/dev/net/tun',
              CgroupPermissions: 'rwm',
            },
          ],
          PortBindings: {
            [`${opts.port}/udp`]: [{ HostPort: String(opts.port) }],
            [`${opts.port}/tcp`]: [{ HostPort: String(opts.port) }],
          },
        },
        ExposedPorts: {
          [`${opts.port}/udp`]: {},
          [`${opts.port}/tcp`]: {},
        },
      }),
    30_000,
    'createContainer',
  );
  await withDockerTimeout(() => container.start(), 60_000, 'container.start');
  return container.id;
}

/**
 * Run a short-lived container (e.g. `sentinel-dvpnx init`) and return
 * captured stdout+stderr once the container exits. The host data dir is
 * mounted in so any state generated persists for the long-running node.
 */
export async function runOnce(opts: {
  hostDataDir: string;
  imageTag: string;
  cmd: string[];
  /**
   * Override the image ENTRYPOINT for this invocation. The sentinel-dvpnx
   * image sets `ENTRYPOINT ["dvpnx"]`, which is correct for `dvpnx init`
   * but wrong when we need to invoke a sibling binary in the same image
   * (e.g. `sentinelhub keys add --recover`) or a shell pipeline. Pass
   * `entrypoint: ['']` to clear it, or `entrypoint: ['/bin/sh', '-c']`
   * to replace it.
   */
  entrypoint?: string[];
  stdin?: string;
  onLog?: (line: string) => void;
  /**
   * Hard timeout (ms) after which the container is force-killed and we
   * resolve with a non-zero exit code. Prevents deploys from hanging
   * forever when, for example, a stdin attach drops EOF on Windows pipes.
   * Default: 180_000 (3 minutes) — keygen / init steps should never take
   * anywhere near that long.
   */
  timeoutMs?: number;
  /**
   * Optional abort signal. When triggered, the container is force-killed
   * and the call resolves with exit code -1 — used so `cancelDeploy` can
   * actually unblock a stuck `container.wait()`.
   */
  signal?: AbortSignal;
}): Promise<{ exitCode: number; output: string }> {
  const c = await getClient();
  await fs.mkdir(opts.hostDataDir, { recursive: true });

  const container = await c.createContainer({
    Image: opts.imageTag,
    Cmd: opts.cmd,
    // Only pass Entrypoint when the caller provides one — omitting the
    // field leaves the image's ENTRYPOINT intact (what `dvpnx init` wants).
    ...(opts.entrypoint ? { Entrypoint: opts.entrypoint } : {}),
    Tty: false,
    OpenStdin: Boolean(opts.stdin),
    StdinOnce: Boolean(opts.stdin),
    AttachStdin: Boolean(opts.stdin),
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${opts.hostDataDir}:/root/.sentinel-dvpnx`],
      AutoRemove: false, // we keep it so we can `wait` for exit code
    },
  });

  const stream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
    stdin: Boolean(opts.stdin),
  });
  const chunks: Buffer[] = [];
  // Live demux state: docker frames can split across TCP chunks, so running
  // stripDockerFrames() on each raw chunk independently mis-decodes a header
  // that straddles a boundary. Demux from a rolling concat of everything seen
  // so far and only forward the newly-revealed text to onLog.
  let liveEmitted = 0;
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    if (opts.onLog) {
      const full = stripDockerFrames(Buffer.concat(chunks));
      if (full.length > liveEmitted) {
        opts.onLog(full.slice(liveEmitted));
        liveEmitted = full.length;
      }
    }
  });

  await container.start();
  if (opts.stdin) {
    stream.write(opts.stdin);
    stream.end();
  }

  const timeoutMs = opts.timeoutMs ?? 180_000;
  let timedOut = false;
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const killContainer = async () => {
    try {
      await container.kill();
    } catch {
      /* already exited */
    }
  };
  const timeoutPromise = new Promise<{ StatusCode: number }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      void killContainer();
      resolve({ StatusCode: 124 });
    }, timeoutMs);
  });
  // Track the abort listener so we can detach it in finally — otherwise each
  // runOnce leaves a live listener on a long-lived deploy-scoped signal, and
  // they stack across keygen/configure/start steps.
  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<{ StatusCode: number }>((resolve) => {
    if (!opts.signal) return;
    if (opts.signal.aborted) {
      aborted = true;
      void killContainer();
      resolve({ StatusCode: -1 });
      return;
    }
    onAbort = () => {
      aborted = true;
      void killContainer();
      resolve({ StatusCode: -1 });
    };
    opts.signal.addEventListener('abort', onAbort);
  });

  let exit: { StatusCode?: number };
  try {
    exit = (await Promise.race([
      container.wait(),
      timeoutPromise,
      abortPromise,
    ])) as { StatusCode?: number };
  } finally {
    if (timer) clearTimeout(timer);
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
  }
  try {
    await container.remove({ force: true });
  } catch {
    /* already gone */
  }

  const code = Number(exit?.StatusCode ?? 0);
  let output = stripDockerFrames(Buffer.concat(chunks));
  if (timedOut) {
    output += `\n[runOnce] timed out after ${Math.round(timeoutMs / 1000)}s — container killed`;
  } else if (aborted) {
    output += '\n[runOnce] aborted — container killed';
  }
  return { exitCode: code, output };
}

/** Fetch the last N lines of a container's combined stdout/stderr. */
export async function containerLogs(containerId: string, tail = 200): Promise<string[]> {
  const c = await getClient();
  try {
    const container = c.getContainer(containerId);
    // follow:false resolves to a Buffer-ish payload; cast via unknown.
    const raw: unknown = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      follow: false,
      timestamps: false,
    } as never);
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    return stripDockerFrames(buf).split(/\r?\n/).filter(Boolean);
  } catch (err) {
    log.debug('containerLogs failed', { id: containerId.slice(0, 12), err: (err as Error).message });
    return [];
  }
}

export async function setRestartPolicy(
  containerId: string,
  policy: 'no' | 'unless-stopped',
): Promise<void> {
  const c = await getClient();
  try {
    const container = c.getContainer(containerId);
    await (container as unknown as {
      update: (opts: { RestartPolicy: { Name: string } }) => Promise<unknown>;
    }).update({ RestartPolicy: { Name: policy } });
  } catch (err) {
    log.debug('setRestartPolicy failed', { policy, err: (err as Error).message });
  }
}

export async function stopContainer(containerId: string): Promise<void> {
  const c = await getClient();
  try {
    await setRestartPolicy(containerId, 'no');
    const container = c.getContainer(containerId);
    await container.stop({ t: 5 });
  } catch (err) {
    log.debug('stopContainer (already stopped?)', { err: (err as Error).message });
  }
}

export async function restartContainer(containerId: string): Promise<void> {
  const c = await getClient();
  const container = c.getContainer(containerId);
  await container.restart({ t: 5 });
}

export async function removeContainer(containerId: string): Promise<void> {
  const c = await getClient();
  try {
    const container = c.getContainer(containerId);
    try {
      await container.stop({ t: 5 });
    } catch {
      /* not running */
    }
    await container.remove({ force: true });
  } catch (err) {
    log.debug('removeContainer failed', { err: (err as Error).message });
  }
}

export async function isRunning(containerId: string): Promise<boolean> {
  const c = await getClient();
  try {
    const info = await c.getContainer(containerId).inspect();
    return Boolean(info.State.Running);
  } catch {
    return false;
  }
}

/** Run a command inside an already-running container and capture output. */
export async function execInside(
  containerId: string,
  cmd: string[],
): Promise<{ exitCode: number; output: string }> {
  const c = await getClient();
  const exec = await c.getContainer(containerId).exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  const info = await exec.inspect();
  return {
    exitCode: info.ExitCode ?? -1,
    output: stripDockerFrames(Buffer.concat(chunks)),
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Docker manager helpers (Manage Docker page)
// ---------------------------------------------------------------------------

const SENTINEL_CONTAINER_PREFIX = 'sentinel-dvpn-';
const SENTINEL_IMAGE_REPO = 'sentinel-dvpn-app/sentinel-dvpnx';

export interface DockerOverview {
  reachable: boolean;
  version?: string;
  apiVersion?: string;
  os?: string;
  arch?: string;
  kernel?: string;
  serverTime?: string;
  totalMemoryMb?: number;
  ncpu?: number;
  rootDir?: string;
  containers: { total: number; running: number; paused: number; stopped: number };
  images: { count: number; sizeBytes: number };
  sentinelContainers: SentinelContainerSummary[];
  sentinelImages: SentinelImageSummary[];
  desktop?: DockerDesktopStatus;
  error?: string;
  reason?: DockerUnreachableReason;
}

export interface SentinelContainerSummary {
  id: string;
  name: string;
  state: string;
  status: string;
  image: string;
  createdUnix: number;
}

export interface SentinelImageSummary {
  id: string;
  tag: string;
  sizeBytes: number;
  createdUnix: number;
}

export async function dockerOverview(): Promise<DockerOverview> {
  const empty: DockerOverview = {
    reachable: false,
    containers: { total: 0, running: 0, paused: 0, stopped: 0 },
    images: { count: 0, sizeBytes: 0 },
    sentinelContainers: [],
    sentinelImages: [],
  };
  try {
    const c = await getClient();
    const [version, info, containers, images] = await Promise.all([
      c.version(),
      c.info(),
      c.listContainers({ all: true }),
      c.listImages({ all: false }),
    ]);

    const sentinelContainers: SentinelContainerSummary[] = containers
      .filter((co) =>
        (co.Names ?? []).some((n) => n.replace(/^\//, '').startsWith(SENTINEL_CONTAINER_PREFIX)),
      )
      .map((co) => ({
        id: co.Id,
        name: (co.Names?.[0] ?? '').replace(/^\//, ''),
        state: co.State,
        status: co.Status,
        image: co.Image,
        createdUnix: co.Created,
      }));

    const sentinelImages: SentinelImageSummary[] = images
      .filter((img) =>
        (img.RepoTags ?? []).some((t) => t.startsWith(SENTINEL_IMAGE_REPO)),
      )
      .map((img) => ({
        id: img.Id,
        tag: (img.RepoTags ?? []).find((t) => t.startsWith(SENTINEL_IMAGE_REPO)) ?? img.Id,
        sizeBytes: img.Size,
        createdUnix: img.Created,
      }));

    const totalImagesSize = images.reduce((sum, i) => sum + (i.Size ?? 0), 0);

    return {
      reachable: true,
      version: version.Version,
      apiVersion: version.ApiVersion,
      os: info.OperatingSystem,
      arch: info.Architecture,
      kernel: info.KernelVersion,
      serverTime: new Date().toISOString(),
      totalMemoryMb: info.MemTotal ? Math.round(info.MemTotal / (1024 * 1024)) : undefined,
      ncpu: info.NCPU,
      rootDir: info.DockerRootDir,
      containers: {
        total: containers.length,
        running: info.ContainersRunning ?? 0,
        paused: info.ContainersPaused ?? 0,
        stopped: info.ContainersStopped ?? 0,
      },
      images: { count: images.length, sizeBytes: totalImagesSize },
      sentinelContainers,
      sentinelImages,
      desktop: await detectDockerDesktop().catch(() => undefined),
    };
  } catch (err) {
    const e = err as Error & { reason?: DockerUnreachableReason; desktop?: DockerDesktopStatus };
    return {
      ...empty,
      error: e.message,
      reason: e.reason,
      desktop: e.desktop ?? (await detectDockerDesktop().catch(() => undefined)),
    };
  }
}

export async function stopAllSentinelContainers(): Promise<{ stopped: number; failed: number }> {
  let stopped = 0;
  let failed = 0;
  try {
    const c = await getClient();
    const containers = await c.listContainers({ all: false });
    const targets = containers.filter((co) =>
      (co.Names ?? []).some((n) => n.replace(/^\//, '').startsWith(SENTINEL_CONTAINER_PREFIX)),
    );
    for (const co of targets) {
      try {
        await c.getContainer(co.Id).stop({ t: 5 });
        stopped += 1;
      } catch (err) {
        log.warn('stopAllSentinelContainers: stop failed', {
          id: co.Id.slice(0, 12),
          err: (err as Error).message,
        });
        failed += 1;
      }
    }
  } catch (err) {
    log.warn('stopAllSentinelContainers: not reachable', { err: (err as Error).message });
    throw err;
  }
  return { stopped, failed };
}

/** Prune dangling images. Does NOT touch tagged sentinel-dvpnx images. */
export async function pruneDangling(): Promise<{ removed: number; reclaimedBytes: number }> {
  const c = await getClient();
  const res = (await c.pruneImages({ filters: { dangling: { true: true } } })) as {
    ImagesDeleted?: unknown[] | null;
    SpaceReclaimed?: number;
  };
  return {
    removed: Array.isArray(res.ImagesDeleted) ? res.ImagesDeleted.length : 0,
    reclaimedBytes: res.SpaceReclaimed ?? 0,
  };
}

/**
 * Quit Docker Desktop on Windows / macOS.
 *
 * macOS: AppleScript `quit app "Docker"` — Docker Desktop handles its own
 * graceful teardown of the linuxkit VM and the docker.sock.
 *
 * Windows: graceful close of the UI window via taskkill (NO `/F` flag) so
 * Docker Desktop's own shutdown handler runs. That handler:
 *   1. Tells `com.docker.backend` to flush state to the WSL2 vhdx.
 *   2. Stops the `com.docker.service` Windows service via the SCM.
 *   3. Issues `wsl --shutdown` on the docker-desktop / docker-desktop-data
 *      distros so the next start-up gets a clean VM.
 * Force-killing those processes (which an earlier version of this code
 * did) skips all three steps and routinely leaves the engine wedged on
 * "Starting the Docker Engine…" until the user runs `wsl --shutdown`
 * manually or reboots.
 *
 * Linux: returns `{ quit: false }` because Docker Engine is a system
 * service and we don't have permission to manage it from a desktop app.
 */
export async function quitDockerDesktop(): Promise<{
  quit: boolean;
  error?: string;
}> {
  if (process.platform === 'linux') {
    return { quit: false, error: 'Docker Engine is a system service on Linux. Use systemctl from a terminal.' };
  }
  try {
    if (process.platform === 'darwin') {
      const child = spawn('osascript', ['-e', 'quit app "Docker"'], {
        detached: false,
        stdio: 'ignore',
        shell: false,
      });
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    } else {
      // Graceful close — no `/F`. taskkill without /F sends WM_CLOSE to the
      // top-level window, which Docker Desktop catches and turns into the
      // same shutdown path as clicking "Quit Docker Desktop" in the tray.
      // That path stops `com.docker.backend` and `com.docker.service`
      // through the SCM in the right order, and runs `wsl --shutdown`
      // on the docker-desktop distros. Skipping it (with /F) corrupts
      // the WSL2 state and leaves the engine wedged on next start.
      await new Promise<void>((resolve) => {
        const child = spawn('taskkill', ['/IM', 'Docker Desktop.exe'], {
          detached: false,
          stdio: 'ignore',
          shell: false,
        });
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
      });
    }
    resetDockerClient();
    log.info('docker desktop quit requested');
    return { quit: true };
  } catch (err) {
    return { quit: false, error: (err as Error).message };
  }
}

/**
 * Last-resort recovery for a wedged Docker Desktop (Windows only).
 *
 * Use when the graceful `quitDockerDesktop()` did nothing — typical
 * symptom is the UI stuck on "Starting the Docker Engine…" with no
 * progress, often triggered by a prior force-kill that left WSL2 in
 * a dirty state.
 *
 * Sequence:
 *   1. Force-kill Docker UI + backend processes (best-effort, /F).
 *   2. `wsl --shutdown` — terminates the docker-desktop and
 *      docker-desktop-data distros so the next start gets a clean VM.
 *      This is the step the graceful path was supposed to run via
 *      Docker Desktop's shutdown handler; if that handler hung, we
 *      run it ourselves.
 *   3. Stop the `com.docker.service` Windows service via SCM
 *      (`sc stop`). If still running, escalate to taskkill /F.
 *   4. Reset the cached dockerode client.
 *
 * Returns a stepwise log so the UI can show the user exactly what
 * recovered and what didn't.
 */
export async function forceQuitDockerDesktop(): Promise<{
  quit: boolean;
  steps: { name: string; ok: boolean; detail?: string }[];
  error?: string;
}> {
  const steps: { name: string; ok: boolean; detail?: string }[] = [];

  if (process.platform === 'linux') {
    return {
      quit: false,
      steps,
      error: 'Force-quit is Windows/macOS only. On Linux use `sudo systemctl restart docker`.',
    };
  }

  const runProcess = (
    cmd: string,
    args: string[],
    timeoutMs = 10_000,
  ): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      let stderr = '';
      const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve({ code: null, stderr: 'timeout' });
      }, timeoutMs);
      child.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString('utf8');
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        resolve({ code: null, stderr: err.message });
      });
    });

  if (process.platform === 'darwin') {
    // macOS: SIGKILL the whole Docker.app tree. AppleScript graceful
    // quit was already tried by the caller; if we're here, it didn't
    // work. `pkill -9 -f Docker` covers the UI helper and the linuxkit
    // hyperkit/vmnet processes.
    const killUI = await runProcess('pkill', ['-9', '-f', 'Docker.app']);
    steps.push({
      name: 'Kill Docker.app',
      ok: killUI.code === 0 || killUI.code === 1, // 1 = no matching processes, also fine
      detail: killUI.stderr || undefined,
    });
    const killVm = await runProcess('pkill', ['-9', '-f', 'com.docker']);
    steps.push({
      name: 'Kill com.docker.* helpers',
      ok: killVm.code === 0 || killVm.code === 1,
      detail: killVm.stderr || undefined,
    });
    resetDockerClient();
    return { quit: true, steps };
  }

  // Windows path.
  // 1. Force-kill UI + backend by image name. Exact names only — never
  //    touch `node.exe` (Claude Code / Electron run on it).
  for (const image of ['Docker Desktop.exe', 'com.docker.backend.exe']) {
    const r = await runProcess('taskkill', ['/F', '/T', '/IM', image]);
    // taskkill returns 128 / 1 when the image isn't running — that's fine.
    const ok = r.code === 0 || /not found|not running/i.test(r.stderr);
    steps.push({
      name: `Force-kill ${image}`,
      ok,
      detail: ok ? undefined : r.stderr.trim() || `exit ${r.code}`,
    });
  }

  // 2. Shut down WSL distros. This is the step that actually unwedges
  //    Docker Desktop on next start — without it, docker-desktop-data
  //    stays mounted with a dirty vhdx and the engine handshake hangs.
  //    `wsl --shutdown` is global; we don't single out distros so we
  //    don't accidentally miss a renamed one.
  const wsl = await runProcess('wsl.exe', ['--shutdown'], 30_000);
  steps.push({
    name: 'wsl --shutdown',
    ok: wsl.code === 0,
    detail: wsl.code === 0 ? undefined : wsl.stderr.trim() || `exit ${wsl.code}`,
  });

  // 3. Stop com.docker.service via the Service Control Manager. `sc
  //    stop` is graceful from the SCM's perspective but doesn't depend
  //    on the Docker Desktop UI being responsive. If it's already
  //    stopped (1062) or doesn't exist (1060), that's a pass.
  const sc = await runProcess('sc.exe', ['stop', 'com.docker.service'], 15_000);
  const scOk = sc.code === 0 || sc.code === 1062 || sc.code === 1060;
  steps.push({
    name: 'sc stop com.docker.service',
    ok: scOk,
    detail: scOk ? undefined : sc.stderr.trim() || `exit ${sc.code}`,
  });

  // 4. If the service refused to stop via SCM, escalate to taskkill.
  //    This should be rare — only happens if Docker's service host is
  //    truly hung, not just "engine not started yet".
  if (!scOk) {
    const r = await runProcess('taskkill', ['/F', '/IM', 'com.docker.service']);
    steps.push({
      name: 'Force-kill com.docker.service',
      ok: r.code === 0 || /not found|not running/i.test(r.stderr),
      detail: r.code === 0 ? undefined : r.stderr.trim() || `exit ${r.code}`,
    });
  }

  resetDockerClient();
  log.info('docker desktop force-quit completed', { steps });
  const allOk = steps.every((s) => s.ok);
  return { quit: allOk, steps, error: allOk ? undefined : 'One or more recovery steps failed.' };
}

/**
 * Docker's log stream multiplexes stdout + stderr with an 8-byte header
 * per frame. Strip headers and decode, then strip ANSI control sequences
 * the dvpnx logger emits (colours, bold) so the renderer's <pre> doesn't
 * print raw `[90m`/`[0m` literals.
 */
function stripDockerFrames(buf: Buffer): string {
  let out = '';
  let p = 0;
  while (p < buf.length) {
    // frame = [stream(1), _, _, _, sizeBE(4), payload]. Need a full 8-byte
    // header before we can read the size — a split/partial header (or a
    // zero-length flush frame leaving <8 bytes) would otherwise make
    // readUInt32BE(p+4) throw RangeError, and that throw escapes the
    // stream 'data' handler (bypassing deploy error handling).
    if (p + 8 > buf.length) {
      // Trailing bytes shorter than a header — not framed; emit raw.
      return stripAnsi(out + buf.slice(p).toString('utf8'));
    }
    const size = buf.readUInt32BE(p + 4);
    if (Number.isNaN(size) || size < 0 || size > 10 * 1024 * 1024 || p + 8 + size > buf.length) {
      // Not a framed payload (or frame straddles this chunk) — return raw.
      return stripAnsi(buf.toString('utf8'));
    }
    out += buf.slice(p + 8, p + 8 + size).toString('utf8');
    p += 8 + size;
  }
  return stripAnsi(out);
}

// Matches ECMA-48 CSI sequences (ESC [ ... final-byte) AND bare 7-bit CSI
// (`\x9b ... final-byte`). Covers SGR (colours), cursor moves, and the rest
// of the terminal-control alphabet — anything we don't want surfacing in the
// deploy log <pre>.
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]|\x9B[0-?]*[ -/]*[@-~]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'

function resolveRunnerPath(): string {
  const candidates = [
    path.join(process.cwd(), 'src/main/ai/runtime/dsh/dsh_runner.py'),
    path.join(process.resourcesPath ?? '', 'dsh', 'dsh_runner.py'),
    path.join(process.resourcesPath ?? '', 'dsh_runner.py')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('dsh_runner.py not found. Expected src/main/ai/runtime/dsh/dsh_runner.py in development.')
}

let cachedPython: string | undefined

export function assertDshSdkInstalled(): void {
  resolveDshPython()
}

export function resolveDshPython(): string {
  if (cachedPython) return cachedPython
  const override = process.env.DSH_PYTHON?.trim()
  const candidates = override
    ? [override]
    : [
        'python3',
        'python',
        path.join(process.cwd(), '.venv/bin/python'),
        path.join(process.env.HOME ?? '', 'NodejsProjects/dsh-cherry-runtime/.venv/bin/python')
      ]
  for (const command of candidates) {
    try {
      const result = spawnSync(command, ['-c', 'import deepseek_harness'], {
        encoding: 'utf8',
        timeout: 8000
      })
      if (result.status === 0) {
        cachedPython = command
        return command
      }
    } catch {
      // try next
    }
  }
  throw new Error(
    'DeepSeek Harness Python SDK is not installed. Run: python3 -m pip install deepseek-harness-sdk (or set DSH_PYTHON)'
  )
}

export type DshWireEvent =
  | { kind: 'ready' }
  | { kind: 'session-event'; sessionId?: string; event?: { type: string; data?: Record<string, unknown> } }
  | { kind: 'status'; sessionId?: string; status?: string }
  | {
      kind: 'result'
      sessionId?: string
      finalResponse?: string
      finishReason?: string
      errorMessage?: string
    }
  | { kind: 'error'; sessionId?: string; message?: string }

export class DshSdkProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private readonly pending: Array<{
    sessionId: string
    onEvent: (event: DshWireEvent) => void
    resolve: (value: DshWireEvent) => void
    reject: (error: Error) => void
  }> = []

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async prompt(input: {
    sessionId: string
    text: string
    cwd: string
    model: string
    onEvent: (event: DshWireEvent) => void
  }): Promise<void> {
    await this.ensure()
    await new Promise<void>((resolve, reject) => {
      this.pending.push({
        sessionId: input.sessionId,
        onEvent: input.onEvent,
        resolve: () => resolve(),
        reject
      })
      this.child?.stdin.write(`${JSON.stringify({ op: 'prompt', ...input })}\n`)
    })
  }

  async close(): Promise<void> {
    if (!this.child) return
    try {
      this.child.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`)
    } catch {
      // already gone
    }
    this.child.kill('SIGTERM')
    this.child = null
    this.ready = null
  }

  private async ensure(): Promise<void> {
    if (this.child && this.ready) return this.ready
    const python = resolveDshPython()
    this.child = spawn(python, [resolveRunnerPath()], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      process.stderr.write(`[dsh] ${chunk}`)
    })
    this.child.on('exit', (code, signal) => {
      const error = new Error(`dsh runner exited (${code ?? signal ?? 'unknown'})`)
      for (const item of this.pending.splice(0)) item.reject(error)
      this.child = null
      this.ready = null
    })

    const lines = createInterface({ input: this.child.stdout })
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('dsh runner did not become ready')), 30_000)
      const onLine = (line: string) => {
        const payload = parseWire(line)
        if (!payload) return
        if (payload.kind === 'ready') {
          clearTimeout(timeout)
          lines.off('line', onLine)
          lines.on('line', (next) => this.dispatch(parseWire(next)))
          resolve()
          return
        }
        if (payload.kind === 'error') {
          clearTimeout(timeout)
          reject(new Error(payload.message || 'dsh runner failed'))
        }
      }
      lines.on('line', onLine)
    })
    return this.ready
  }

  private dispatch(payload: DshWireEvent | null): void {
    if (!payload) return
    const current = this.pending[0]
    if (!current) return
    current.onEvent(payload)
    if (payload.kind === 'result') {
      this.pending.shift()
      current.resolve(payload)
      return
    }
    if (payload.kind === 'error' && (!payload.sessionId || payload.sessionId === current.sessionId)) {
      this.pending.shift()
      current.reject(new Error(payload.message || 'dsh runtime error'))
    }
  }
}

function parseWire(line: string): DshWireEvent | null {
  try {
    return JSON.parse(line) as DshWireEvent
  } catch {
    return null
  }
}

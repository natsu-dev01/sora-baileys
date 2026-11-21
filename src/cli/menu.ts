import { createInterface } from 'node:readline/promises'
import { emitKeypressEvents } from 'node:readline'

export interface MenuChoice<T> {
  value: T
  label: string
  hint?: string
}

export interface MenuConfig<T> {
  title?: string
  choices: MenuChoice<T>[]
  initialIndex?: number
}

const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/**
 * Selector con flechas y atajos numéricos. Si no hay TTY cae a un menú por
 * texto, así que también funciona en CI o pipes.
 */
export async function choose<T>(config: MenuConfig<T>): Promise<T> {
  if (config.choices.length === 0) throw new Error('choose() necesita al menos una opción')
  if (!process.stdin.isTTY || !process.stdout.isTTY) return chooseFromLine(config)
  return chooseWithArrows(config)
}

/** Pregunta de texto simple (para el número del pairing code). */
export async function promptText(question: string, defaultValue = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : ''
    const answer = (await rl.question(`${question}${suffix}: `)).trim()
    return answer || defaultValue
  } finally {
    rl.close()
  }
}

async function chooseFromLine<T>(config: MenuConfig<T>): Promise<T> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if (config.title) console.log(config.title)
    config.choices.forEach((choice, index) => {
      const hint = choice.hint ? ` ${DIM}- ${choice.hint}${RESET}` : ''
      console.log(`  ${index + 1}) ${choice.label}${hint}`)
    })

    for (;;) {
      const answer = (await rl.question('Opción: ')).trim().toLowerCase()
      if (answer === 'q' || answer === 'salir' || answer === 'exit') {
        throw new Error('selección cancelada')
      }
      const index = Number.parseInt(answer, 10) - 1
      if (Number.isInteger(index) && index >= 0 && index < config.choices.length) {
        const choice = config.choices[index]
        if (choice) return choice.value
      }
      console.log('Opción no válida. Usa un número o q para salir.')
    }
  } finally {
    rl.close()
  }
}

function chooseWithArrows<T>(config: MenuConfig<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let selected = clampIndex(config.initialIndex ?? 0, config.choices.length)
    let renderedLines = 0
    let finished = false

    const render = (): void => {
      const lines: string[] = []
      if (config.title) lines.push(`${BOLD}${config.title}${RESET}`)
      config.choices.forEach((choice, index) => {
        const marker = index === selected ? `${CYAN}❯${RESET}` : ' '
        const label = index === selected ? `${CYAN}${choice.label}${RESET}` : choice.label
        const hint = choice.hint ? ` ${DIM}${choice.hint}${RESET}` : ''
        lines.push(` ${marker} ${index + 1}) ${label}${hint}`)
      })
      lines.push(`${DIM}↑/↓ o 1-9 · Enter confirma · q sale${RESET}`)

      if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}A`)
      for (const line of lines) process.stdout.write(`\x1b[2K\r${line}\n`)
      renderedLines = lines.length
    }

    const finish = (callback: () => void): void => {
      if (finished) return
      finished = true
      cleanup()
      callback()
    }

    const onKey = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === 'c') {
        finish(() => reject(new Error('selección cancelada')))
        return
      }
      switch (key.name) {
        case 'up':
        case 'k':
          selected = (selected - 1 + config.choices.length) % config.choices.length
          render()
          return
        case 'down':
        case 'j':
          selected = (selected + 1) % config.choices.length
          render()
          return
        case 'return':
        case 'enter':
          finish(() => resolve(config.choices[selected]!.value))
          return
        case 'escape':
        case 'q':
          finish(() => reject(new Error('selección cancelada')))
          return
        default: {
          const numeric = Number.parseInt(key.name ?? '', 10)
          if (Number.isInteger(numeric) && numeric >= 1 && numeric <= config.choices.length) {
            selected = numeric - 1
            render()
          }
        }
      }
    }

    const cleanup = (): void => {
      process.stdin.off('keydown', onKey)
      if (wasRaw !== undefined) process.stdin.setRawMode?.(wasRaw)
      process.stdout.write('\x1b[?25h')
    }

    const wasRaw = process.stdin.isRaw
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdout.write('\x1b[?25l')
    process.stdin.on('keydown', onKey)
    render()
  })
}

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0
  return ((Math.trunc(index) % length) + length) % length
}

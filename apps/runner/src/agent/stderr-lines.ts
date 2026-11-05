// Keep only line state: partial lines must be visible at the next log flush.
export function stderrLines(): (text: string) => string {
  let atLineStart = true
  return text => {
    let output = ''
    for (const character of text) {
      if (character === '\n') {
        output += character
        atLineStart = true
      } else {
        if (atLineStart) output += '[stderr] '
        output += character
        atLineStart = false
      }
    }
    return output
  }
}

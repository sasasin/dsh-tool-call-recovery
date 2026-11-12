/** Mask quoted Markdown without moving offsets. No model text is ever evaluated. */
export function maskExamples(text) {
  let fence;
  const lines = text.split(/(?<=\n)/);
  return lines.map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length
        && line.slice(marker[0].length).trim() === '') fence = undefined;
      return line.replace(/[^\n]/g, ' ');
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      return line.replace(/[^\n]/g, ' ');
    }
    if (/^(?: {0,3}>| {4}|\t)/.test(line)) return line.replace(/[^\n]/g, ' ');
    return line.replace(/(`+)[^\n]*?\1/g, match => ' '.repeat(match.length));
  }).join('');
}

/** Find trailing, standalone XML calls. Complete functions can lack the outer closer. */
export function detectToolCallText(text, { maxTextChars = 65536 } = {}) {
  if (typeof text !== 'string' || text.length > maxTextChars) return [];
  const masked = maskExamples(text);
  const call = /^ {0,3}<tool_call>\s*<function=([A-Za-z0-9_.:-]+)>\s*(?:<parameter=[A-Za-z0-9_.:-]+>[\s\S]*?<\/parameter>\s*)*<\/function>\s*(?:<\/tool_call>)?/gm;
  const matches = [...masked.matchAll(call)];
  if (!matches.length) return [];
  // Require the entire suffix to be calls. Prose after a sample makes it an example.
  const last = matches.at(-1);
  if (masked.slice(last.index + last[0].length).trim()) return [];
  const trailing = [last];
  for (let i = matches.length - 2; i >= 0; i--) {
    const prior = matches[i];
    if (masked.slice(prior.index + prior[0].length, trailing[0].index).trim()) break;
    trailing.unshift(prior);
  }
  const prefix = masked.slice(0, trailing[0].index).trimEnd();
  if (/(?:例|引用|example|sample|syntax|format)(?:\s*[:：])?\s*$/i.test(prefix.split('\n').at(-1) ?? '')) return [];
  return [...new Set(trailing.map(match => match[1]))];
}

// md-fast: a faster drop-in for marked 18.1.3.
//
// parse(markdown) returns exactly the HTML that marked.parse(markdown)
// returns with marked's default options (GFM on, breaks off, pedantic off),
// for less CPU. The speed comes from driving marked's own Lexer and
// Tokenizer with index-based loops instead of marked's substring loops:
//
//   - the block loop walks the source by offset and only tries a block
//     tokenizer when the first character can start that block;
//   - the inline loop dispatches on the first character, so most positions
//     try one rule instead of nine, and plain text is consumed by a small
//     hand-written scanner instead of a regex;
//   - emphasis and strikethrough share one closer scan per inline run,
//     cached on the tokenizer, instead of rescanning for every opener;
//   - the carriage-return normalisation is skipped when the input holds
//     no carriage return at all.
//
// Nothing is cached from one parse call to the next: every call builds a
// fresh lexer, a fresh tokenizer and a fresh options object, so a case
// renders exactly as it would on its own. marked itself is vendored under
// vendor/marked/ and subclassed here; its licence and notice travel with it.

import { Lexer, Parser, Tokenizer } from './vendor/marked/marked.esm.js';

// The carriage-return pattern marked normalises before lexing. Kept here so
// the fast path below can test for '\r' first and skip the replace.
const CARRIAGE_RETURN = /\r\n|\r/g;

// Fresh options per call, matching marked's defaults, so no mutable state
// is shared between two parses through marked's shared defaults object.
function freshOptions() {
  return {
    async: false,
    breaks: false,
    extensions: null,
    gfm: true,
    hooks: null,
    pedantic: false,
    renderer: null,
    silent: false,
    tokenizer: new FastTokenizer(),
    walkTokens: null,
  };
}

// Render one markdown string to the HTML marked would produce for it.
export function parse(src) {
  const options = freshOptions();
  const lexer = new FastBlockLexer(options);
  const tokens = lexer.lex(src);
  const html = Parser.parse(tokens, options);
  lexer.dropCaches();
  return html;
}

// ---------------------------------------------------------------------------
// Small character helpers. Everything here works on UTF-16 code units, the
// same units the regexes they replace work on, so astral characters (emoji
// and friends) simply pass through as two units that match no stop rule.
// ---------------------------------------------------------------------------

// ASCII letters and digits.
function isAlnumCode(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122);
}

// The characters that may appear in an email address local part or domain
// for the purpose of stopping a text run: [a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-].
function isEmailCharCode(code) {
  if (isAlnumCode(code)) return true;
  switch (code) {
    case 33: // !
    case 35: // #
    case 36: // $
    case 37: // %
    case 38: // &
    case 39: // '
    case 42: // *
    case 43: // +
    case 45: // -
    case 46: // .
    case 47: // /
    case 61: // =
    case 63: // ?
    case 94: // ^
    case 95: // _
    case 96: // `
    case 123: // {
    case 124: // |
    case 125: // }
    case 126: // ~
      return true;
    default:
      return false;
  }
}

// ASCII punctuation, the exact set a backslash can escape in inline text.
function isEscapePunctCode(code) {
  return (code >= 33 && code <= 47)
    || (code >= 58 && code <= 64)
    || (code >= 91 && code <= 96)
    || (code >= 123 && code <= 126);
}

// The five characters marked treats as whitespace before a delimiter run.
function isDelimSpaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

const MULTI_SPACE = /\s+/g;

// Normalise a link label so a definition and a reference to it meet on the
// same key: trim, collapse inner whitespace to one space, then fold case
// through upper case (so 'SS' meets 'ß', which plain lower-casing misses).
function normalizeLabel(label) {
  return label.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Numeric character references outside code stand for the character they
// name; a zero, out-of-range or surrogate value becomes the replacement
// character, and a '&' that is not already a reference is escaped here so a
// decoded character cannot join its neighbours into a new reference.
const NUMERIC_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!text.includes('&#') || !NUMERIC_REF_TEST.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

// ---------------------------------------------------------------------------
// Closer index for emphasis and strikethrough. One scan of a masked inline
// run records the start of the last '*' run, the last '_' run and the last
// '~' run that can close a span (a run counts only when the character
// before it is not whitespace). An opener whose window holds no such run
// cannot match, so it bails out before marked's closer search runs at all.
// The scan is cached per masked source string on the tokenizer and dropped
// when the parse that built it ends.
// ---------------------------------------------------------------------------

function scanClosers(masked) {
  let ast = -1;
  let und = -1;
  let tilde = -1;
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (!isDelimSpaceCode(prev.charCodeAt(0))) {
      if (ch === '~') tilde = i;
      else if (ch === '*') ast = i;
      else und = i;
    }
    i = j - 1;
  }
  return { ast, und, tilde };
}

// Tokenizer with a cached closer index. emStrong and del keep marked's own
// matching code and only add the cheap bail-out above it: when the cached
// index says no closer exists ahead, they return without running it.
// ---------------------------------------------------------------------------
// Index-based helpers for the list() rewrite. Marked's list() tests six
// regexes per line and splits/substrings the source as it consumes it;
// these do the same tests by walking characters, with no regex and no
// per-line allocation beyond the line strings themselves.
// ---------------------------------------------------------------------------

// The block tags that can open an HTML block of types (1)-(6), from the
// marked grammar, with h1-h6 expanded.
const HTML_BEGIN_TAGS = new Set(('address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul|h1|h2|h3|h4|h5|h6').split('|'));

// Count the leading spaces of s, stopping at max + 1 (a count above max
// means the line is too indented for the rule being tested).
function countSpaces(s, max) {
  let k = 0;
  while (k < s.length && s[k] === ' ' && k <= max) k++;
  return k;
}

function isAsciiLetter(ch) {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'));
}

function isSpaceChar(ch) {
  if (ch === undefined) return false;
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f') return true;
  return ch.charCodeAt(0) > 127 && /\s/.test(ch);
}

// ^ {0,indent}(?:```|~~~)
function isFencesBegin(s, indent) {
  indent = Math.max(0, Math.min(3, indent - 1));
  const k = countSpaces(s, indent);
  if (k > indent) return false;
  return s.startsWith('```', k) || s.startsWith('~~~', k);
}

// ^ {0,indent}#{1,6}(?:\s|$) — pedantic drops the trailing-space test.
function isHeadingBegin(s, indent, pedantic) {
  indent = Math.max(0, Math.min(3, indent - 1));
  const k = countSpaces(s, indent);
  if (k > indent) return false;
  let h = 0;
  while (k + h < s.length && s[k + h] === '#') h++;
  if (h === 0 || h > 6) return false;
  if (pedantic) return true;
  const after = k + h;
  return after >= s.length || isSpaceChar(s[after]);
}

// ^ {0,indent}(?:</?(?:tag)(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)
function isHtmlBegin(s, indent) {
  indent = Math.max(0, Math.min(3, indent - 1));
  const k = countSpaces(s, indent);
  if (k > indent || s[k] !== '<') return false;
  const i = k;
  if (s.startsWith('<!--', i) || s.startsWith('<?', i) || s.startsWith('<![CDATA[', i)) return true;
  if (s[i + 1] === '!' && isAsciiLetter(s[i + 2])) return true;
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') {
    closing = true;
    j++;
  }
  if (!closing) {
    for (const w of ['script', 'pre', 'style', 'textarea']) {
      if (startsWithIgnoreCase(s, w, j)) {
        const after = j + w.length;
        if (after >= s.length || s[after] === '>' || isSpaceChar(s[after])) return true;
      }
    }
  }
  let nameEnd = j;
  while (nameEnd < s.length) {
    const c = s[nameEnd];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) break;
    nameEnd++;
  }
  if (nameEnd === j) return false;
  if (!HTML_BEGIN_TAGS.has(s.slice(j, nameEnd).toLowerCase())) return false;
  if (nameEnd >= s.length) return true;
  const c = s[nameEnd];
  if (c === ' ' || c === '>') return true;
  return c === '/' && s[nameEnd + 1] === '>';
}

// ^ {0,indent}>
function isBlockquoteBegin(s, indent) {
  indent = Math.max(0, Math.min(3, indent - 1));
  const k = countSpaces(s, indent);
  if (k > indent) return false;
  return s[k] === '>';
}

// ^ {0,indent}(?:[*+-]|\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))
function isNextBullet(s, indent) {
  indent = Math.max(0, Math.min(3, indent - 1));
  const k = countSpaces(s, indent);
  if (k > indent) return false;
  let after;
  const c = s[k];
  if (c === '*' || c === '+' || c === '-') {
    after = k + 1;
  } else {
    let d = k;
    while (d < s.length && s[d] >= '0' && s[d] <= '9' && d - k < 9) d++;
    if (d === k || d >= s.length || (s[d] !== '.' && s[d] !== ')')) return false;
    after = d + 1;
  }
  return after >= s.length || s[after] === ' ' || s[after] === '\t' || s[after] === '\n';
}

// ^ {0,indent}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)
// on a single line: the run must reach the end of the line.
function isHrLine(s, indent) {
  indent = Math.max(0, Math.min(3, indent - 1));
  const k = countSpaces(s, indent);
  if (k > indent) return false;
  const c = s[k];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let i = k;
  let n = 0;
  while (i < s.length && s[i] === c) {
    n++;
    i++;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  }
  return n >= 3 && i >= s.length;
}

// The block hr rule on the remainder starting at p: same groups, then
// newlines or the end of the string.
function isHrRemainder(src, p, len) {
  let i = p;
  let spaces = 0;
  while (i < len && src[i] === ' ' && spaces < 3) {
    i++;
    spaces++;
  }
  const c = src[i];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  let n = 0;
  while (i < len && src[i] === c) {
    n++;
    i++;
    while (i < len && (src[i] === ' ' || src[i] === '\t')) i++;
  }
  return n >= 3 && (i >= len || src[i] === '\n');
}

// ^ {0,3}(?:=+|-+) *$
function isSetextLine(s) {
  const k = countSpaces(s, 3);
  if (k > 3) return false;
  const c = s[k];
  if (c !== '=' && c !== '-') return false;
  let i = k;
  while (i < s.length && s[i] === c) i++;
  if (i === k) return false;
  while (i < s.length && s[i] === ' ') i++;
  return i >= s.length;
}

// /^[ \t]*$/ on the slice src[start..end).
function isBlankLineAt(src, start, end) {
  for (let i = start; i < end; i++) {
    if (src[i] !== ' ' && src[i] !== '\t') return false;
  }
  return true;
}

// !s.trim(): every character is whitespace.
function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f') continue;
    if (ch.charCodeAt(0) < 128) return false;
    if (!/\s/.test(ch)) return false;
  }
  return true;
}

// s.search(/[^ ]/): the first character that is not a space (-1 if none).
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ') return i;
  }
  return -1;
}

// The leading-space count of s after replacing each tab with four spaces:
// a space adds one, a tab adds four, and the count stops at the first
// other character.
function leadingSpaceCount(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') n++;
    else if (s[i] === '\t') n += 4;
    else break;
  }
  return n;
}

// Expand the leading whitespace run of s to spaces, as if expandTabs ran
// over it starting at column indent. A run of only spaces is unchanged.
function expandLeadingTabs(s, indent) {
  let k = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k === 0) return s;
  let col = indent;
  for (let i = 0; i < k; i++) {
    if (s[i] === '\t') col += 4 - (col % 4);
    else col++;
  }
  return ' '.repeat(col - indent) + s.slice(k);
}

// expandTabs over a whole line (pedantic mode only).
function expandTabsStr(s, indent) {
  let col = indent;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// /\n[ \t]*\n[ \t]*$/ on s.
function endsWithDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  return true;
}

// The list-item regex, by hand: ^( {0,3}bull)((?:[\t ][^\n]*)?(?:\n|$)).
// Returns the length of the bullet part, the first line after the bullet
// (space/tab and content, without the newline), and the offset just past
// the first line's newline — or null when the bullet does not match.
function matchListItemAt(src, p, len, bullChar, bullTerm, isordered, pedantic) {
  let i = p;
  let spaces = 0;
  while (i < len && src[i] === ' ' && spaces < 3) {
    i++;
    spaces++;
  }
  let bulletLen = 0;
  if (isordered) {
    let d = i;
    while (d < len && src[d] >= '0' && src[d] <= '9' && d - i < 9) d++;
    if (d === i || d >= len || src[d] !== bullTerm) return null;
    bulletLen = d - i + 1;
  } else {
    if (i >= len) return null;
    const c = src[i];
    if (pedantic) {
      if (c !== '*' && c !== '+' && c !== '-') return null;
    } else if (c !== bullChar) {
      return null;
    }
    bulletLen = 1;
  }
  const afterBullet = i + bulletLen;
  const cap1Len = afterBullet - p;
  let firstLine;
  let end;
  if (afterBullet < len && (src[afterBullet] === ' ' || src[afterBullet] === '\t')) {
    let e = src.indexOf('\n', afterBullet + 1);
    if (e === -1) e = len;
    firstLine = src.slice(afterBullet, e);
    end = e < len ? e + 1 : len;
  } else if (afterBullet < len && src[afterBullet] === '\n') {
    firstLine = '';
    end = afterBullet + 1;
  } else if (afterBullet >= len) {
    firstLine = '';
    end = len;
  } else {
    return null;
  }
  return { cap1Len, firstLine, end };
}

// ---------------------------------------------------------------------------
// Manual emStrong / del matching. Marked's closer search runs its RDelim
// regexes over the whole clipped source for every opener; the same
// classification is done here by walking delimiter runs and looking at
// their neighbours, which is what those regexes amount to.
// ---------------------------------------------------------------------------

const PUNCT_RE = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_RE = /[\s\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

// Unicode punctuation or a symbol. In the GFM strong/em rules a tilde
// does not count as punctuation (it can be struck through instead).
function isPunctChar(ch, gfmStrongEm) {
  if (ch === '~' && gfmStrongEm) return false;
  return PUNCT_RE.test(ch);
}

function isPunctSpaceChar(ch, gfmStrongEm) {
  if (ch === '~' && gfmStrongEm) return false;
  return PUNCT_OR_SPACE_RE.test(ch);
}

function isNotPunctSpaceChar(ch, gfmStrongEm) {
  if (ch === '~' && gfmStrongEm) return true;
  return !PUNCT_OR_SPACE_RE.test(ch);
}

// The code point at position i of s (one or two UTF-16 units), or ''.
function codePointAt(s, i) {
  if (i >= s.length) return '';
  const hi = s[i];
  if (hi >= '\ud800' && hi <= '\udbff' && i + 1 < s.length) {
    const lo = s[i + 1];
    if (lo >= '\udc00' && lo <= '\udfff') return s.slice(i, i + 2);
  }
  return hi;
}

// The code point just before position i of s, or ''.
function codePointBefore(s, i) {
  if (i <= 0) return '';
  const lo = s[i - 1];
  if (lo >= '\udc00' && lo <= '\udfff' && i >= 2) {
    const hi = s[i - 2];
    if (hi >= '\ud800' && hi <= '\udbff') return s.slice(i - 2, i);
  }
  return lo;
}

// The orphan skip of the RDelim regexes: a lone delimiter run sitting
// between two strong runs of the other delimiter (`__a*b__` or `**a_b**`)
// is not a closer. Scans s from start; returns the absolute offset to
// start scanning runs from, or start when there is no such orphan.
function orphanSkipEnd(s, start, len, delim) {
  const strong = delim === '*' ? '_' : '*';
  let i = start;
  while (i < len) {
    const c = s[i];
    if (c === delim) return start;
    if (c === strong) {
      if (s[i + 1] === strong) break;
      return start;
    }
    i++;
  }
  if (i >= len || s[i + 1] !== strong) return start;
  i += 2;
  while (i < len) {
    const c = s[i];
    if (c === strong) return start;
    if (c === delim) break;
    i++;
  }
  if (i >= len) return start;
  i++;
  while (i < len) {
    const c = s[i];
    if (c === delim) return start;
    if (c === strong) {
      if (s[i + 1] === strong) return i;
      return start;
    }
    i++;
  }
  return start;
}

class FastTokenizer extends Tokenizer {
  constructor(options) {
    super(options);
    this.closerFrames = new Map();
  }

  closerFrame(masked) {
    let frame = this.closerFrames.get(masked);
    if (frame === undefined) {
      frame = scanClosers(masked);
      this.closerFrames.set(masked, frame);
    }
    return frame;
  }

  // Emphasis and strong, without marked's regexes: the opener is read by
  // hand, then delimiter runs ahead of it are classified by their
  // neighbours exactly as the RDelim regexes classify them. The GFM rules
  // apply to `*` (a tilde is not punctuation there); `_` keeps the plain
  // rules, as in marked's grammar selection.
  emStrong(src, maskedSrc, prevChar = '') {
    const delim = src[0];
    if (delim !== '*' && delim !== '_') return undefined;
    const gfmStrongEm = delim === '*';

    // The left delimiter: a run of the delimiter, then one character that
    // is punctuation or a non-space character. No such character means
    // this run cannot open.
    let run = 0;
    while (run < src.length && src[run] === delim) run++;
    const after = codePointAt(src, run);
    if (after === '' || isSpaceChar(after)) return undefined;
    const afterIsPunct = isPunctChar(after, true);
    const nextChar = afterIsPunct ? after : '';

    const midRun = prevChar === delim;

    // Find the start of the whole delimiter run this opener belongs to:
    // flanking and rules 9-10 are about the run, not just its tail. The
    // run may start before src, either taken as text after a failed match
    // or used to close an earlier span.
    const srcStart = maskedSrc.length - src.length;
    let runStart = srcStart;
    while (runStart > 0 && maskedSrc[runStart - 1] === delim) runStart--;
    const runPrevChar = codePointBefore(maskedSrc, runStart);
    // The plain punctuation test here (a tilde counts as punctuation),
    // unlike the GFM strong/em classification below.
    const runPrevPunct = runPrevChar !== '' && isPunctSpaceChar(runPrevChar, false);
    if (runStart < srcStart) prevChar = runPrevChar;
    const prevPunct = runStart < srcStart
      ? runPrevPunct
      : prevChar !== '' && prevChar !== '*' && prevChar !== '_' && PUNCT_OR_SPACE_RE.test(prevChar);

    // '_' cannot open between two alphanumerics.
    if (delim === '_' && !afterIsPunct && ALNUM_RE.test(prevChar)) return undefined;

    if (nextChar === '' || prevChar === '' || prevPunct) {
      const lLength = run;
      let delimTotal = lLength;
      let midDelimTotal = 0;

      // Normal rules have no group 6 for `_`: an underscore run between
      // two alphanumerics cannot close emphasis (`a_b` stays literal).
      // Pedantic mode adds it back.
      const hasGroup6 = delim === '*' || !!this.options.pedantic;

      // Rules 9-10 count the whole run, and also apply when the opener
      // could close as well (`a*b**`, where `*` is both left- and
      // right-flanking).
      const runLength = srcStart - runStart + lLength;
      const openerCanClose = !this.options.pedantic && runPrevChar.trim() !== ''
        && (nextChar !== '' || (delim === '*' && !runPrevPunct));
      const frame = this.closerFrame(maskedSrc);
      const lastPossible = delim === '*' ? frame.ast : frame.und;
      const windowStart = srcStart + lLength;
      if (lastPossible < windowStart) return undefined;
      const lastPossibleInWindow = lastPossible - windowStart;
      const maskedLen = maskedSrc.length;
      let pos = orphanSkipEnd(maskedSrc, windowStart, maskedLen, delim);

      while (pos < maskedLen) {
        while (pos < maskedLen && maskedSrc[pos] !== delim) pos++;
        if (pos >= maskedLen) break;
        const runStartAbs = pos;
        while (pos < maskedLen && maskedSrc[pos] === delim) pos++;
        const runEndAbs = pos;
        const runPos = runStartAbs - windowStart;
        if (runPos === 0) continue;
        const prev = codePointBefore(maskedSrc, runStartAbs);
        const prevLen = prev.length;
        if (runPos - prevLen > lastPossibleInWindow) break;
        const next = codePointAt(maskedSrc, runEndAbs);
        const rLength = runEndAbs - runStartAbs;

        const prevIsPunct = prev !== '' && isPunctChar(prev, gfmStrongEm);
        const prevIsPunctSpace = prev !== '' && isPunctSpaceChar(prev, gfmStrongEm);
        const prevIsSpace = prev !== '' && isSpaceChar(prev);
        const prevIsNotPunctSpace = prev !== '' && isNotPunctSpaceChar(prev, gfmStrongEm);
        const nextIsSpace = next !== '' && isSpaceChar(next);
        const nextIsPunctSpace = next !== '' && isPunctSpaceChar(next, gfmStrongEm);
        const nextIsPunct = next !== '' && isPunctChar(next, gfmStrongEm);
        const nextIsNotPunctSpace = next !== '' && isNotPunctSpaceChar(next, gfmStrongEm);

        let group = 0;
        if (prevIsPunct && (nextIsSpace || next === '')) group = 1;
        else if (prevIsNotPunctSpace && (nextIsPunctSpace || next === '')) group = 2;
        else if (prevIsPunctSpace && nextIsNotPunctSpace) group = 3;
        else if (prevIsSpace && nextIsPunct) group = 4;
        else if (prevIsPunct && nextIsPunct) group = 5;
        else if (hasGroup6 && prevIsNotPunctSpace && nextIsNotPunctSpace) group = 6;
        if (group === 0) continue;

        if (group === 3 || group === 4) {
          delimTotal += rLength;
          continue;
        }
        if (group === 5 || group === 6 || openerCanClose) {
          if (midRun && (group === 5 || group === 6)) break;
          if (runLength % 3 !== 0 && (runLength + rLength) % 3 === 0) {
            midDelimTotal += rLength;
            continue;
          }
        }

        delimTotal -= rLength;
        if (delimTotal > 0) continue;

        // Remove extra characters. *a*** -> *a*
        const usedLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
        const raw = src.slice(0, lLength + runPos + usedLength);

        if (Math.min(lLength, usedLength) % 2 === 1) {
          const text = raw.slice(1, -1);
          return {
            type: 'em',
            raw,
            text,
            tokens: this.lexer.inlineTokens(text),
          };
        }
        const text = raw.slice(2, -2);
        return {
          type: 'strong',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
    return undefined;
  }

  // Strikethrough, without marked's regexes: the same run classification
  // as emStrong, with plain punctuation (a tilde counts as punctuation
  // here), no orphan skip, no rules 9-10, and a closer must be exactly
  // as long as the opener.
  del(src, maskedSrc, prevChar = '') {
    if (src[0] !== '~') return undefined;
    let count = 0;
    while (count < src.length && src[count] === '~') count++;
    if (count > 2) return undefined;
    const lLength = count;
    const after = codePointAt(src, lLength);
    if (after === '' || isSpaceChar(after)) return undefined;
    const nextChar = isPunctChar(after, false) ? after : '';

    if (nextChar === '' || prevChar === ''
      || (prevChar !== '*' && prevChar !== '_' && PUNCT_OR_SPACE_RE.test(prevChar))) {
      const frame = this.closerFrame(maskedSrc);
      const srcStart = maskedSrc.length - src.length;
      const windowStart = srcStart + lLength;
      if (frame.tilde < windowStart) return undefined;
      const lastPossibleInWindow = frame.tilde - windowStart;
      const maskedLen = maskedSrc.length;
      let delimTotal = lLength;
      let pos = windowStart;

      while (pos < maskedLen) {
        while (pos < maskedLen && maskedSrc[pos] !== '~') pos++;
        if (pos >= maskedLen) break;
        const runStartAbs = pos;
        while (pos < maskedLen && maskedSrc[pos] === '~') pos++;
        const runEndAbs = pos;
        const rLength = runEndAbs - runStartAbs;
        if (rLength > 2) continue;
        const runPos = runStartAbs - windowStart;
        if (runPos === 0) continue;
        const prev = codePointBefore(maskedSrc, runStartAbs);
        if (runPos - prev.length > lastPossibleInWindow) break;
        const next = codePointAt(maskedSrc, runEndAbs);

        if (rLength !== lLength) continue;

        const prevIsPunct = prev !== '' && isPunctChar(prev, false);
        const prevIsPunctSpace = prev !== '' && isPunctSpaceChar(prev, false);
        const prevIsSpace = prev !== '' && isSpaceChar(prev);
        const prevIsNotPunctSpace = prev !== '' && isNotPunctSpaceChar(prev, false);
        const nextIsSpace = next !== '' && isSpaceChar(next);
        const nextIsPunctSpace = next !== '' && isPunctSpaceChar(next, false);
        const nextIsPunct = next !== '' && isPunctChar(next, false);
        const nextIsNotPunctSpace = next !== '' && isNotPunctSpaceChar(next, false);

        let group = 0;
        if (prevIsPunct && (nextIsSpace || next === '')) group = 1;
        else if (prevIsNotPunctSpace && (nextIsPunctSpace || next === '')) group = 2;
        else if (prevIsPunctSpace && nextIsNotPunctSpace) group = 3;
        else if (prevIsSpace && nextIsPunct) group = 4;
        else if (prevIsPunct && nextIsPunct) group = 5;
        else if (prevIsNotPunctSpace && nextIsNotPunctSpace) group = 6;
        if (group === 0) continue;

        if (group === 3 || group === 4) {
          delimTotal += rLength;
          continue;
        }

        delimTotal -= rLength;
        if (delimTotal > 0) continue;

        const usedLength = Math.min(rLength, rLength + delimTotal);
        const raw = src.slice(0, lLength + runPos + usedLength);
        const text = raw.slice(lLength, -lLength);
        return {
          type: 'del',
          raw,
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      }
    }
    return undefined;
  }

  // A list, without per-line regexes or string shrinking: the source is
  // walked by offset, each line is tested by the index-based helpers
  // above, and only the item texts are built as strings. Every branch
  // mirrors marked's list() line for line.
  list(src) {
    const cap = this.rules.block.list.exec(src);
    if (!cap) return undefined;
    const listSrc = src;
    const len = src.length;
    let bull = cap[1].trim();
    const isordered = bull.length > 1;

    const list = {
      type: 'list',
      raw: '',
      ordered: isordered,
      start: isordered ? +bull.slice(0, -1) : '',
      loose: false,
      items: [],
    };

    const bullChar = isordered ? '' : bull;
    const bullTerm = isordered ? bull.slice(-1) : '';
    const pedantic = !!this.options.pedantic;
    const gfm = !!this.options.gfm;
    let endsWithBlankLine = false;
    let p = 0;

    while (p < len) {
      let endEarly = false;
      let itemContents = '';
      const m = matchListItemAt(src, p, len, bullChar, bullTerm, isordered, pedantic);
      if (!m) break;

      // End the list if the bullet was actually a thematic break.
      if (isHrRemainder(src, p, len)) break;

      const itemStart = p;
      p = m.end;

      const firstLine = m.firstLine;
      const bulletIndent = m.cap1Len;
      let line = pedantic
        ? expandTabsStr(firstLine, bulletIndent)
        : expandLeadingTabs(firstLine, bulletIndent);
      let nlEnd = src.indexOf('\n', p);
      if (nlEnd === -1) nlEnd = len;
      let blankLine = isBlankStr(line);

      let indent = 0;
      if (pedantic) {
        indent = 2;
        itemContents = line.trimStart();
      } else if (blankLine) {
        indent = bulletIndent + 1;
      } else {
        indent = firstNonSpace(line);
        indent = indent > 4 ? 1 : indent;
        itemContents = line.slice(indent);
        indent += bulletIndent;
      }

      if (blankLine && isBlankLineAt(src, p, nlEnd)) {
        // Items begin with at most one blank line.
        p = nlEnd + 1;
        if (p > len) p = len;
        endEarly = true;
      }

      if (!endEarly) {
        // Check if following lines should be included in the list item.
        while (p < len) {
          let rEnd = src.indexOf('\n', p);
          if (rEnd === -1) rEnd = len;
          const rawLine = src.slice(p, rEnd);
          const nextLineWithoutTabs = pedantic
            ? rawLine.replace(this.rules.other.listReplaceNesting, '  ')
            : expandLeadingTabs(rawLine, 0);

          if (isFencesBegin(rawLine, indent)) break;
          if (isHeadingBegin(rawLine, indent, pedantic)) break;
          if (isHtmlBegin(rawLine, indent)) break;
          if (isBlockquoteBegin(rawLine, indent)) break;
          if (isNextBullet(rawLine, indent)) break;
          if (isHrLine(rawLine, indent)) break;

          if (firstNonSpace(nextLineWithoutTabs) >= indent || isBlankStr(rawLine)) {
            // Dedent if possible.
            itemContents += '\n' + nextLineWithoutTabs.slice(indent);
          } else {
            // Not enough indentation.
            if (blankLine) break;
            if (leadingSpaceCount(line) >= 4) break;
            if (isFencesBegin(line, indent)) break;
            if (isHeadingBegin(line, indent, pedantic)) break;
            if (isHtmlBegin(line, indent)) break;
            if (isHrLine(line, indent)) break;

            // A lazy continuation can look like a setext underline after
            // list indentation is removed. Keep it in the paragraph.
            const setextContinuation = !pedantic
              && isSetextLine(rawLine)
              && this.rules.block.lheading.test(line + '\n' + rawLine);
            const continuation = setextContinuation
              ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
              : rawLine;
            itemContents += '\n' + continuation;
          }

          blankLine = isBlankStr(rawLine);
          p = rEnd + 1;
          if (p > len) p = len;
          line = nextLineWithoutTabs.slice(indent);
        }
      }

      // The loops above appended a '\n' the source may not have had. It
      // could only land on the item that exhausts src, whose raw is
      // trimmed below, and after which nothing reads endsWithBlankLine.
      const raw = listSrc.slice(itemStart, p);

      if (!list.loose) {
        if (endsWithBlankLine) {
          list.loose = true;
        } else if (endsWithDoubleBlank(raw)) {
          endsWithBlankLine = true;
        }
      }

      list.items.push({
        type: 'list_item',
        raw,
        task: gfm && this.rules.other.listIsTask.test(itemContents),
        loose: false,
        text: itemContents,
        tokens: [],
      });
    }

    // Do not consume newlines at end of final item.
    const lastItem = list.items.at(-1);
    if (lastItem) {
      lastItem.raw = lastItem.raw.trimEnd();
      lastItem.text = lastItem.text.trimEnd();
    } else {
      // Not a list since there were no items.
      return undefined;
    }
    list.raw = listSrc.slice(0, p).trimEnd();

    // Item child tokens handled here at end because we needed to have the
    // final item to trim it first. First pass: tokenize items and finalize
    // list.loose from spacers before placing checkboxes.
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);

      if (!list.loose) {
        const spacers = item.tokens.filter(t => t.type === 'space');
        const hasMultipleLineBreaks = spacers.length > 0 && spacers.some(t => this.rules.other.anyLine.test(t.raw));
        list.loose = hasMultipleLineBreaks;
      }
    }

    // Second pass: place task checkboxes using the final list.loose.
    for (const item of list.items) {
      const itemToken = item.tokens[0];
      if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
        item.text = item.text.replace(this.rules.other.listReplaceTask, '');
        itemToken.raw = itemToken.raw.replace(this.rules.other.listReplaceTask, '');
        itemToken.text = itemToken.text.replace(this.rules.other.listReplaceTask, '');
        for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
          if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[i].src)) {
            this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(this.rules.other.listReplaceTask, '');
            break;
          }
        }

        const taskRaw = this.rules.other.listTaskCheckbox.exec(item.raw);
        if (taskRaw) {
          const checkboxToken = {
            type: 'checkbox',
            raw: taskRaw[0] + ' ',
            checked: taskRaw[0] !== '[ ]',
          };
          item.checked = checkboxToken.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
              item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(checkboxToken);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: checkboxToken.raw,
                text: checkboxToken.raw,
                tokens: [checkboxToken],
              });
            }
          } else {
            item.tokens.unshift(checkboxToken);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }

    // Set all items to loose if list is loose.
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) {
          if (token.type === 'text') {
            token.type = 'paragraph';
          }
        }
      }
    }

    return list;
  }
}

// ---------------------------------------------------------------------------
// Fast lexer. The block loop and the inline loop below walk the source by
// offset and hand marked's tokenizers the remainder only when a rule can
// plausibly match there, instead of re-slicing and re-trying every rule at
// every position the way marked's loops do.
// ---------------------------------------------------------------------------

class FastLexer extends Lexer {
  constructor(options) {
    super(options);
    // The tokenizer the constructor installed (a FastTokenizer when built
    // through freshOptions). Kept for the cache drop at the end of a parse.
    this.fastTokenizer = this.tokenizer;
  }

  // Drop every closer frame the tokenizer cached for this parse, so no
  // masked source (and no string it points at) is kept into the next case.
  dropCaches() {
    this.fastTokenizer.closerFrames.clear();
  }

  // Does this link text hold a link already? An image does not count: an
  // image may hold a link, a link may not.
  linkInText(text) {
    if (!text.includes('[')) return false;
    const linkRule = this.tokenizer.rules.inline.link;
    for (const match of text.matchAll(this.tokenizer.rules.inline.blockSkip)) {
      // blockSkip also matches code spans and html, and the '!' of an image
      // is left out of the match, so read the character before it.
      if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
    }
    for (const match of text.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      const match0 = match[0];
      const refStart = match0.lastIndexOf('[');
      if (match0.charAt(0) === '!'
        || !Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        continue;
      }
      // A candidate holding a link is not a link either, so it does not count.
      if (refStart > 1 && this.linkInText(match0.slice(1, refStart - 1))) continue;
      return true;
    }
    return false;
  }

  // Mask links, code, html and escapes so emStrong and del do not see their
  // delimiters inside them. Every mask keeps the length it replaces, so
  // emStrong and del can line the masked source up with the real one by
  // slicing from the end.
  maskSource(src) {
    const rules = this.tokenizer.rules;
    let masked = src;

    // Mask out reflinks.
    if (this.tokens.links && src.includes('[')) {
      const search = rules.inline.reflinkSearch;
      const maskOne = (match0) => {
        const refStart = match0.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
          return match0;
        }
        // Links may not contain other links, at any level of nesting. A
        // candidate whose text already holds one never becomes a link, so
        // flattening the whole span would hide the emphasis that does
        // still apply inside it. Mask the links it holds instead. Images
        // are exempt: their text is flattened into an alt attribute.
        if (refStart > 1 && match0.charAt(0) !== '!') {
          const text = match0.slice(1, refStart - 1);
          if (this.linkInText(text)) {
            return '[' + text.replace(search, maskOne)
              + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(match0.length - 2) + ']';
      };
      masked = masked.replace(search, maskOne);
    }

    // Mask out escaped characters. A backslash inside a code span is
    // literal, not an escape. Mask the backticks inside the span instead,
    // so blockSkip still skips all of it. The pattern can only match a
    // backslash escape or a code span, so skip the pass entirely when
    // the run holds neither a backslash nor a backtick.
    if (src.includes('\\') || src.includes('`')) {
      masked = masked.replace(rules.inline.anyPunctuationOutsideCode, (match0, code, punct) => {
        if (punct) return '+'.repeat(match0.length);
        if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
        return match0;
      });
    }

    // Mask out other blocks: links, code spans and html. Skip the pass
    // when the run holds none of the characters those can start with.
    if (src.includes('[') || src.includes('`') || src.includes('<')) {
      masked = masked.replace(rules.inline.blockSkip, (match0, _link, context) => {
        const offset = context ? context.length : 0;
        return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
      });
    }

    // Mask out blocks from extensions.
    masked = this.options.hooks?.emStrongMask?.call({ lexer: this }, masked) ?? masked;

    return masked;
  }

  // Preprocessing: normalise carriage returns, tokenize blocks, then drain
  // the queued inline runs. The replace is skipped outright when the input
  // holds no carriage return, which is the common case.
  lex(src) {
    if (src.includes('\r')) src = src.replace(CARRIAGE_RETURN, '\n');

    this.blockTokens(src, this.tokens);

    for (let i = 0; i < this.inlineQueue.length; i++) {
      const next = this.inlineQueue[i];
      // An inline <pre>, <code>, <kbd> or <script> left open ends with the
      // block holding it; carried over, it would stop every later block's
      // text from being escaped.
      this.state.inRawBlock = false;
      this.inlineTokens(next.src, next.tokens);
    }
    this.inlineQueue = [];

    return this.tokens;
  }

  // Lex one inline run. Anchors one paren scan for the run, shared with
  // Tokenizer.link: without a ')' ahead the link regex cannot match, and
  // skipping it avoids its quadratic backtracking over unterminated-link
  // inputs. A nested run receives a substring of the outer run, so if the
  // outer had no ')' neither does this substring; the flag is restored for
  // the rest of the outer run when the nested one returns.
  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    const prevParenPossible = this.state.linkParenPossible;
    this.state.linkParenPossible = prevParenPossible && src.includes(')');
    try {
      // The masked source is only read by emStrong and del, which need a
      // '*', '_' or '~' to start. Skip building it for a run without one:
      // neither method is ever called for such a run.
      const masked = (src.includes('*') || src.includes('_') || src.includes('~'))
        ? this.maskSource(src)
        : src;
      return this.runInline(src, masked, tokens);
    } finally {
      this.state.linkParenPossible = prevParenPossible;
    }
  }

  // The inline loop, walking the run by offset. At each position the first
  // character decides which rules can match there, in marked's own order,
  // so a position tries one or two rules instead of all nine; anything no
  // rule takes is consumed by the text scanner below. The state machine
  // (prevChar, and whether it survives into the next position) is marked's:
  // a text token keeps its last character as prevChar for the next rule,
  // except when it ends in '_', where prevChar stays what it was before
  // that run of underscores started.
  runInline(src, masked, tokens) {
    const tz = this.tokenizer;
    const links = this.tokens.links;
    const len = src.length;
    let pos = 0;
    let prevChar = '';
    let keepPrev = false;
    let guard = Infinity;
    while (pos < len) {
      const remaining = len - pos;
      if (remaining >= guard) {
        this.infiniteLoopError(src.charCodeAt(pos));
        break;
      }
      guard = remaining;

      if (!keepPrev) prevChar = '';
      keepPrev = false;

      const ch = src[pos];
      const code = src.charCodeAt(pos);
      let token;
      let reflinkText = false;
      if (code === 92) {
        token = escapeAt(src, pos);
        if (token === undefined) token = brAt(src, pos);
      } else if (code === 60) {
        const rest = src.slice(pos);
        token = tz.tag(rest);
        if (token === undefined) token = tz.autolink(rest);
      } else if (code === 91 || code === 33) {
        // A link or full reference link needs '](' or '][' after the label.
        // Without either anywhere ahead, only a shortcut reference link
        // can match, and only when the bracketed label is a defined
        // reference. Most '[' in prose are not links at all, so skip both
        // regexes outright when neither case can match.
        let mayLink = src.indexOf('](', pos) !== -1 || src.indexOf('][', pos) !== -1;
        if (!mayLink) {
          const labelStart = ch === '!' ? pos + 2 : pos + 1;
          let labelEnd = -1;
          for (let j = labelStart; j < len; j++) {
            const lc = src.charCodeAt(j);
            if (lc === 92) {
              j++;
              continue;
            }
            if (lc === 93) {
              labelEnd = j;
              break;
            }
            if (lc === 91) break;
          }
          if (labelEnd !== -1) {
            mayLink = links[normalizeLabel(src.slice(labelStart, labelEnd))] !== undefined;
          }
        }
        if (mayLink) {
          const rest = src.slice(pos);
          token = tz.link(rest);
          if (token === undefined) {
            token = tz.reflink(rest, links);
            reflinkText = token !== undefined && token.type === 'text';
          }
        } else {
          // No link or full reference can match, but a shortcut reference
          // that matches with an undefined label still yields a
          // one-character text token in marked, so the loop retries the
          // rules (a www. link, say) at the next position instead of
          // swallowing the bracket as text.
          const nolink = nolinkTextAt(src, pos, ch);
          if (nolink === true) {
            token = { type: 'text', raw: ch, text: ch };
            reflinkText = true;
          } else if (nolink === 'defer') {
            token = tz.reflink(src.slice(pos), links);
            reflinkText = token !== undefined && token.type === 'text';
          }
        }
      } else if (code === 42) {
        token = tz.emStrong(src.slice(pos), masked, prevChar);
      } else if (code === 95) {
        const rest = src.slice(pos);
        token = tz.emStrong(rest, masked, prevChar);
        if (token === undefined && !this.state.inLink && urlMayMatch(src, pos)) {
          token = tz.url(rest);
        }
      } else if (code === 96) {
        token = codespanAt(src, pos);
      } else if (code === 126) {
        token = tz.del(src.slice(pos), masked, prevChar);
      } else if (code === 32) {
        token = brAt(src, pos);
      } else if (code === 46 || code === 43 || code === 45) {
        if (!this.state.inLink && urlMayMatch(src, pos)) token = tz.url(src.slice(pos));
      } else if (isAlnumCode(code)) {
        if (!this.state.inLink && urlMayMatch(src, pos)) token = tz.url(src.slice(pos));
      }

      if (token !== undefined) {
        pos += token.raw.length;
        if (reflinkText) {
          // A failed reference falls back to a lone '[' or '!' as text,
          // which joins the text token before it when there is one.
          const last = tokens[tokens.length - 1];
          if (last !== undefined && last.type === 'text') {
            last.raw += token.raw;
            last.text += token.text;
          } else {
            tokens.push(token);
          }
        } else {
          tokens.push(token);
        }
        continue;
      }

      const start = pos;
      const end = scanText(src, start);
      pos = end;
      const raw = src.slice(start, end);
      const inRaw = this.state.inRawBlock;
      const textToken = {
        type: 'text',
        raw,
        // Raw HTML keeps whatever it was written with; everywhere else a
        // numeric character reference stands for the character itself.
        text: inRaw ? raw : decodeNumericRefs(raw),
        escaped: inRaw,
      };
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrev = true;
      const last = tokens[tokens.length - 1];
      if (last !== undefined && last.type === 'text') {
        last.raw += textToken.raw;
        last.text += textToken.text;
      } else {
        tokens.push(textToken);
      }
    }
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Inline helpers.
// ---------------------------------------------------------------------------

// A backslash escape: a backslash followed by ASCII punctuation yields an
// escape token holding that one character. Anything else is not an escape.
function escapeAt(src, pos) {
  if (pos + 1 >= src.length) return undefined;
  if (!isEscapePunctCode(src.charCodeAt(pos + 1))) return undefined;
  return { type: 'escape', raw: src.slice(pos, pos + 2), text: src[pos + 1] };
}

// Case-insensitive prefix test, ASCII only (the schemes it tests are ASCII).
function startsWithIgnoreCase(src, lit, pos) {
  if (pos + lit.length > src.length) return false;
  for (let k = 0; k < lit.length; k++) {
    const a = src.charCodeAt(pos + k);
    const b = lit.charCodeAt(k);
    if (a === b) continue;
    if (a >= 65 && a <= 90 && a + 32 === b) continue;
    if (a >= 97 && a <= 122 && a - 32 === b) continue;
    return false;
  }
  return true;
}

// Can the extended-autolink rule match at pos? It matches www. links,
// scheme:// links, mailto:/xmpp: links, and bare email addresses, so the
// test is a superset of its first characters plus a cheap look-ahead for
// the '@' an email needs. The rule itself still decides; this only avoids
// calling it where it cannot match.
function urlMayMatch(src, pos) {
  if (src.startsWith('www.', pos)) return true;
  const c = src[pos];
  if (c === 'h' || c === 'H') {
    if (startsWithIgnoreCase(src, 'http://', pos)
      || startsWithIgnoreCase(src, 'https://', pos)) return true;
  } else if (c === 'f' || c === 'F') {
    if (startsWithIgnoreCase(src, 'ftp://', pos)) return true;
  } else if (c === 'm' && src.startsWith('mailto:', pos)) {
    return true;
  } else if (c === 'x' && src.startsWith('xmpp:', pos)) {
    return true;
  }
  let i = pos;
  const len = src.length;
  while (i < len && isEmailCharCode(src.charCodeAt(i))) i++;
  return i > pos && i < len && src[i] === '@';
}

// Start of the maximal run of email characters ending just before the '@'
// at index at, not scanning before bound.
function emailRunStart(src, bound, at) {
  let s = at - 1;
  while (s >= bound && isEmailCharCode(src.charCodeAt(s))) s--;
  return s + 1;
}

// The shortcut/collapsed reference rule, by hand: ^!?[(ref)](?:\[\])?
// with ref = (?!\s*\])(?:\\[\s\S]|[^\\[\\]\n]|\n(?![ \t]*\n))+.
// When it matches but the label is not a defined reference, marked
// returns a one-character text token instead of a link, so the loop
// retries the rules at the next position. Returns true when that token
// applies, 'defer' when the label holds a '<' (the base must decide
// whether the label ends inside a tag), and false when the rule cannot
// match here.
function nolinkTextAt(src, pos, ch) {
  if (ch === '!' && src[pos + 1] !== '[') return false;
  const labelStart = ch === '!' ? pos + 2 : pos + 1;
  const len = src.length;
  if (labelStart >= len) return false;
  let i = labelStart;
  while (i < len && isSpaceChar(src[i])) i++;
  if (i < len && src[i] === ']') return false;
  let j = labelStart;
  let count = 0;
  let hasLt = false;
  while (j < len) {
    const c = src[j];
    if (c === '\\') {
      if (j + 1 >= len) break;
      j += 2;
      count += 2;
      continue;
    }
    if (c === '[' || c === ']') break;
    if (c === '\n') {
      let k = j + 1;
      while (k < len && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < len && src[k] === '\n') break;
      j++;
      count++;
      continue;
    }
    if (c === '<') hasLt = true;
    j++;
    count++;
  }
  if (j >= len || src[j] !== ']' || count === 0) return false;
  if (hasLt) return 'defer';
  return true;
}

// A 'www.' only stops a text run when the character before it is the start
// of the run, whitespace, '*', '_', '~' or '(' (the lookbehind in marked's
// text rule); after any other character the 'www.' is plain text.
function isWwwPreceding(code) {
  return code === 32 || code === 9 || code === 10 || code === 11
    || code === 12 || code === 13 || code === 42 || code === 95
    || code === 126 || code === 40;
}

// Find where the text run starting at start ends, replicating marked's
// inline text rule: the run ends before any character that can start
// another inline rule, before a hard-break run of spaces, and before a
// www. link, a scheme:// link, a mailto:/xmpp: link, or an email address.
// The first character is always consumed, as the rule consumes it; when
// the run starts with backticks or tildes, the whole run is consumed, so
// a later backtick of the same run is never offered to the code-span rule
// on its own (a run that opens no span is literal text, all of it).
function scanText(src, start) {
  const len = src.length;
  let i = start + 1;
  if (src[start] === '`' || src[start] === '~') {
    const mark = src[start];
    while (i < len && src[i] === mark) i++;
  }
  // The text rule consumes the first character (or a whole backtick or
  // tilde run) before it looks for an email address, so the email run
  // can only start here or later: scanning back past this point would
  // swallow the characters already consumed as text. The first position
  // at or after here where an email-character run reaches a '@' is where
  // the text stops for an email, even when that run crosses a dispatch
  // character such as '_' (an email character itself).
  const floor = i;
  let emailStop = -1;
  let atPos = src.indexOf('@', floor);
  while (atPos !== -1) {
    let r = atPos - 1;
    while (r >= 0 && isEmailCharCode(src.charCodeAt(r))) r--;
    if (r + 1 < atPos) {
      const s = Math.max(r + 1, floor);
      if (s < atPos) {
        emailStop = s;
        break;
      }
    }
    atPos = src.indexOf('@', atPos + 1);
  }
  while (i < len) {
    if (i === emailStop) return i;
    const code = src.charCodeAt(i);
    // 92 \, 60 <, 33 !, 91 [, 96 `, 42 *, 95 _, 126 ~
    if (code === 92 || code === 60 || code === 33 || code === 91
      || code === 96 || code === 42 || code === 95 || code === 126) {
      break;
    }
    if (code === 32) {
      let j = i;
      while (j < len && src.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && src.charCodeAt(j) === 10) break;
      i = j;
      continue;
    }
    if (code === 119 && src.startsWith('www.', i) && isWwwPreceding(src.charCodeAt(i - 1))) break;
    if (code === 104 || code === 72) {
      if ((src.charCodeAt(i + 1) === 116 || src.charCodeAt(i + 1) === 84)
        && (startsWithIgnoreCase(src, 'http://', i)
          || startsWithIgnoreCase(src, 'https://', i))) break;
    } else if (code === 102 || code === 70) {
      if ((src.charCodeAt(i + 1) === 116 || src.charCodeAt(i + 1) === 84)
        && startsWithIgnoreCase(src, 'ftp://', i)) break;
    }
    if (code === 109 || code === 120) {
      if ((src.startsWith('mailto:', i) || src.startsWith('xmpp:', i))
        && i > start && !isAlnumCode(src.charCodeAt(i - 1))) break;
    }
    i++;
  }
  return i;
}

const NEWLINE_GLOBAL = /\n/g;
const NON_SPACE = /[^ ]/;

// A code span, without a regex: the opening run of backticks is greedy,
// and the first later run of exactly that many backticks closes it (a
// longer run cannot close, since its backticks would either follow the
// closer or join the content). Newlines inside become spaces, and one
// space is stripped from each end when the content has a non-space
// character and spaces on both ends.
function codespanAt(src, pos) {
  const len = src.length;
  let open = pos;
  while (open < len && src[open] === '`') open++;
  const n = open - pos;
  let i = open;
  while (i < len) {
    if (src[i] !== '`') {
      i++;
      continue;
    }
    let runEnd = i;
    while (runEnd < len && src[runEnd] === '`') runEnd++;
    if (runEnd - i === n && i > open) {
      let text = src.slice(open, i).replace(NEWLINE_GLOBAL, ' ');
      if (NON_SPACE.test(text) && text[0] === ' ' && text[text.length - 1] === ' ') {
        text = text.substring(1, text.length - 1);
      }
      return { type: 'codespan', raw: src.slice(pos, runEnd), text };
    }
    i = runEnd;
  }
  return undefined;
}

// A hard line break, without a regex: two or more spaces, or a backslash,
// followed by a newline, provided something other than whitespace follows
// it, plus any trailing spaces or tabs.
function brAt(src, pos) {
  let j;
  if (src[pos] === '\\') {
    if (src[pos + 1] !== '\n') return undefined;
    j = pos + 2;
  } else if (src[pos] === ' ') {
    j = pos;
    while (src[j] === ' ') j++;
    if (j - pos < 2 || src[j] !== '\n') return undefined;
    j++;
  } else {
    return undefined;
  }
  const len = src.length;
  let k = j;
  while (k < len) {
    const code = src.charCodeAt(k);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13 && code !== 12 && code !== 11) break;
    k++;
  }
  if (k === len) return undefined;
  while (j < len && (src[j] === ' ' || src[j] === '\t')) j++;
  return { type: 'br', raw: src.slice(pos, j) };
}

// ---------------------------------------------------------------------------
// Block loop. Walks the source by offset and tries each block tokenizer
// only when the first character can start that block, in marked's own
// order. Table and setext headings get a cheap line-shape test first,
// since their regexes are the most expensive to run and fail.
// ---------------------------------------------------------------------------

class FastBlockLexer extends FastLexer {
  blockTokens(src, tokens = [], lastParagraphClipped = false) {
    this.tokenizer.lexer = this;
    const len = src.length;
    let pos = 0;
    let guard = Infinity;
    while (pos < len) {
      const remaining = len - pos;
      if (remaining >= guard) {
        this.infiniteLoopError(src.charCodeAt(pos));
        break;
      }
      guard = remaining;

      const ch = src[pos];
      const rest = src.slice(pos);
      let token;

      // newline
      if ((ch === '\n' || ch === ' ' || ch === '\t')
        && (token = this.tokenizer.space(rest))) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          // A single '\n' as a spacer terminates the last line, so move
          // it there instead of making an unnecessary paragraph break.
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }

      // code
      if ((ch === ' ' || ch === '\t') && (token = this.tokenizer.code(rest))) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        // An indented code block cannot interrupt a paragraph.
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      // fences
      if ((ch === '`' || ch === '~' || ch === ' ' || ch === '\t')
        && (token = this.tokenizer.fences(rest))) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }

      // heading
      if ((ch === '#' || ch === ' ' || ch === '\t')
        && (token = this.tokenizer.heading(rest))) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }

      // hr
      if ((ch === '-' || ch === '_' || ch === '*' || ch === ' ' || ch === '\t')
        && (token = this.tokenizer.hr(rest))) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }

      // blockquote
      if ((ch === '>' || ch === ' ' || ch === '\t')
        && (token = this.tokenizer.blockquote(rest))) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }

      // list
      if ((ch === '*' || ch === '+' || ch === '-' || ch === ' ' || ch === '\t'
        || (ch >= '0' && ch <= '9'))
        && (token = this.tokenizer.list(rest))) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }

      // html
      if ((ch === '<' || ch === ' ' || ch === '\t')
        && (token = this.tokenizer.html(rest))) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }

      // def
      if ((ch === '[' || ch === ' ' || ch === '\t')
        && (token = this.tokenizer.def(rest))) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          // The first definition of a label wins, but a later one still
          // consumes its text.
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = {
              href: token.href,
              title: token.title,
            };
          }
          tokens.push(token);
        }
        continue;
      }

      // table (gfm)
      if (tableMayMatch(src, pos) && (token = this.tokenizer.table(rest))) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }

      // lheading
      if (setextMayMatch(src, pos) && (token = this.tokenizer.lheading(rest))) {
        pos += token.raw.length;
        tokens.push(token);
        continue;
      }

      // top-level paragraph
      if (this.state.top && (token = this.tokenizer.paragraph(rest))) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = false;
        continue;
      }

      // text
      if (token = this.tokenizer.text(rest)) {
        pos += token.raw.length;
        const lastToken = tokens.at(-1);
        if (lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }

      if (pos < len) {
        this.infiniteLoopError(src.charCodeAt(pos));
        break;
      }
    }

    this.state.top = true;
    return tokens;
  }
}

// ---------------------------------------------------------------------------
// Block pre-checks.
// ---------------------------------------------------------------------------

// Can a table start at pos? Only the delimiter row is tested here: it must
// sit on the next line, hold at most three leading spaces, and consist
// only of pipes, colons, dashes and spaces, with at least one dash and at
// least one pipe or colon (a bare '---' row is a setext underline, not a
// table). Anything else cannot be a table, so the table regex is skipped.
function tableMayMatch(src, pos) {
  const firstBreak = src.indexOf('\n', pos);
  if (firstBreak === -1) return false;
  const lineStart = firstBreak + 1;
  let lineEnd = src.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = src.length;
  let i = lineStart;
  let leading = 0;
  while (i < lineEnd && src[i] === ' ' && leading < 3) {
    i++;
    leading++;
  }
  if (i < lineEnd && src[i] === ' ') return false;
  let dashes = 0;
  let pipes = 0;
  let colons = 0;
  for (; i < lineEnd; i++) {
    const c = src[i];
    if (c === '-') dashes++;
    else if (c === '|') pipes++;
    else if (c === ':') colons++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return dashes > 0 && (pipes > 0 || colons > 0);
}

// Can a setext heading start at pos? Its underline must sit on a later
// line, before any blank line (a blank line ends the heading's content),
// and look like up to three spaces, a run of '=' or '-', then only spaces
// or tabs. The scan stays loose about what the content lines hold: the
// heading regex itself still decides, this only avoids running it where
// no underline exists at all.
function setextMayMatch(src, pos) {
  const len = src.length;
  let firstBreak = src.indexOf('\n', pos);
  if (firstBreak === -1) return false;
  let lineStart = firstBreak + 1;
  while (lineStart < len) {
    let lineEnd = src.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = len;
    let blank = true;
    for (let i = lineStart; i < lineEnd; i++) {
      if (src[i] !== ' ' && src[i] !== '\t') {
        blank = false;
        break;
      }
    }
    if (blank) return false;
    let i = lineStart;
    let leading = 0;
    while (i < lineEnd && src[i] === ' ' && leading < 3) {
      i++;
      leading++;
    }
    if (i < lineEnd && (src[i] === '=' || src[i] === '-')) {
      const mark = src[i];
      let j = i;
      while (j < lineEnd && src[j] === mark) j++;
      let k = j;
      while (k < lineEnd && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k === lineEnd) return true;
    }
    lineStart = lineEnd + 1;
  }
  return false;
}



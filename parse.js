// parse.js — a fast drop-in for marked 18.1.3 with its default options
// (GFM on, breaks off, pedantic off, async off). parse(markdown) returns
// exactly the HTML marked 18.1.3 renders, for every string.
//
// The parser is a fork of marked 18.1.3 (MIT, see vendor/marked/LICENSE):
// the vendored build is used untouched, and this file subclasses its
// Tokenizer and Lexer to make the hot paths faster while keeping every
// token byte-identical:
//  - the inline loop dispatches on the first character instead of trying
//    every inline tokenizer's regex on every token,
//  - the inline text token is found by a hand-written scanner that
//    reproduces the GFM text regex's match boundary exactly,
//  - the emStrong/del masking pass is skipped when a source holds no
//    emphasis character, and its regex replaces are skipped when the
//    source cannot contain what they match,
//  - the block loop skips each block tokenizer's regex when the next
//    character cannot start that construct, and skips the table and
//    setext-heading regexes when the following lines cannot hold one.
//
// Nothing is cached across cases: every parse() builds a fresh lexer and
// parser, so each case is rendered from its own markdown alone.
import { Lexer, Tokenizer, Parser } from './vendor/marked/marked.esm.js';

// ---------------------------------------------------------------------------
// Small character helpers (ASCII unless noted).
// ---------------------------------------------------------------------------

function isAlnum(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// JS \s (what the text regex's www. lookbehind uses): space, tab, LF, VT,
// FF, CR, NBSP, Ogham space, en/em spaces, line/paragraph separators,
// narrow NBSP, medium math space, ideographic space, BOM.
function isSpace(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}

// Characters that may appear in an email address, per the GFM text regex.
function isEmailChar(c) {
  return isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 ||
    c === 37 || c === 38 || c === 39 || c === 42 || c === 43 || c === 47 ||
    c === 61 || c === 63 || c === 96 || c === 123 || c === 124 ||
    c === 125 || c === 126 || c === 45;
}

// Normalises a link reference label, exactly like marked's internal F().
function normalizeLabel(a) {
  return a.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Decodes numeric character references and bare ampersands in a text token,
// exactly like marked's internal Ie().
function decodeEntities(a, other) {
  if (!other.numericCharacterReference.test(a)) return a;
  return a.replace(other.numericCharacterReferenceOrAmpersand, (e, t, n) => {
    if (t === void 0 && n === void 0) return '&amp;';
    const s = t === void 0 ? Number.parseInt(n, 16) : Number.parseInt(t, 10);
    if (s === 0 || s > 1114111 || (s >= 55296 && s <= 57343)) return '�';
    if (s === 38) return '&amp;';
    return String.fromCodePoint(s);
  });
}

// The next stop character of the GFM text regex: \ < ! [ ` * ~ _
const STOP_RE = /[\\<\[!`*~_]/g;

// Expands tabs in a string to spaces, exactly like marked's internal J():
// each tab advances to the next multiple of 4 columns.
function expandTabs(a, e = 0) {
  let t = e, n = '';
  for (const s of a) {
    if (s === '\t') {
      const r = 4 - t % 4;
      n += ' '.repeat(r);
      t += r;
    } else {
      n += s;
      t++;
    }
  }
  return n;
}

// The first line of `s` (up to the first newline, or the whole string).
function firstLine(s) {
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}

// Whether a line holds only whitespace (what !s.trim() tests, without the
// allocation; non-ASCII whitespace falls back to a regex test).
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) continue;
    if (c < 128) return false;
    return /^\s*$/.test(s);
  }
  return true;
}

// The index of the first character of `s` that is not a space, or -1 when
// `s` holds only spaces (what s.search(/[^ ]/) returns).
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 32) return i;
  }
  return -1;
}

// The indent of `s` after expanding its tabs to four spaces each, or -1
// when `s` holds only spaces and tabs (what
// s.replace(/\t/g, "    ").search(/[^ ]/) returns).
function expandedIndent(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) n++;
    else if (c === 9) n += 4;
    else return n;
  }
  return -1;
}

// Whether `s` ends with a blank line: a newline, optional spaces/tabs, a
// newline, optional spaces/tabs, then the end (what /\n[ \t]*\n[ \t]*$/
// tests).
function endsWithBlankLine(s) {
  let j = s.length;
  while (j > 0 && (s.charCodeAt(j - 1) === 32 || s.charCodeAt(j - 1) === 9)) j--;
  if (j < 1 || s.charCodeAt(j - 1) !== 10) return false;
  let i = j - 2;
  while (i >= 0 && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i--;
  return i >= 0 && s.charCodeAt(i) === 10;
}

// Whether a line ends a list item: it starts a fence, heading, HTML block,
// block quote, another list item, or a thematic break. The regexes are
// anchored with `^ {0,R}`, so only a line whose first non-space character
// (after at most R spaces) can start one of those constructs needs its
// regex run; the rest cannot match. `rx` holds the regexes to test, with
// null for the ones this call does not test.
function listLineBreak(s, R, rx) {
  let sp = 0;
  while (sp < s.length && s.charCodeAt(sp) === 32) sp++;
  if (sp > R || sp >= s.length) return false;
  const fc = s.charCodeAt(sp);
  if (fc === 42) return (rx.v && rx.v.test(s)) || (rx.Q && rx.Q.test(s));
  if (fc === 43) return !!rx.v && rx.v.test(s);
  if (fc === 45) return (rx.v && rx.v.test(s)) || (rx.Q && rx.Q.test(s));
  if (fc === 95) return !!rx.Q && rx.Q.test(s);
  if (fc === 96 || fc === 126) return !!rx.ee && rx.ee.test(s);
  if (fc === 35) return !!rx.te && rx.te.test(s);
  if (fc === 60) return !!rx.M && rx.M.test(s);
  if (fc === 62) return !!rx.ne && rx.ne.test(s);
  if (fc >= 48 && fc <= 57) return !!rx.v && rx.v.test(s);
  return false;
}

// Whether a line is a setext underline: up to three spaces, a run of =
// or -, then only spaces (what /^ {0,3}(?:=+|-+) *$/" tests).
function isSetextLine(s) {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= s.length) return false;
  const c = s.charCodeAt(i);
  if (c !== 61 && c !== 45) return false;
  let j = i + 1;
  while (j < s.length && s.charCodeAt(j) === c) j++;
  while (j < s.length && s.charCodeAt(j) === 32) j++;
  return j === s.length;
}

// Whether a line holds only spaces and tabs (what /^[ \t]*$/ tests).
function isSpaceTabBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// The number of code points in `s` (what [...s].length counts), without
// building the array.
function codePointLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xDC00 && c <= 0xDFFF) continue;
    n++;
  }
  return n;
}

// The last possible emphasis/strikethrough closer indices in a masked
// source, as marked's private fe() computes them: for "*" and "_" the
// index of the last delimiter run whose preceding character is not a
// space, and for "~" the same. (The run scan skips the whole run once
// its first character is seen, so the recorded index is the run start.)
function closerIndices(a) {
  const e = { '*': -1, _: -1 };
  let t = -1;
  const n = a.length;
  for (let s = 0; s < n; s++) {
    const r = a[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : a[s - 1];
    let i = s + 1;
    for (; i < n && a[i] === r;) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') t = s;
      else e[r] = s;
    }
    s = i - 1;
  }
  return { em: e, del: t };
}

// ---------------------------------------------------------------------------
// The inline text token, found by search instead of by the GFM text regex.
//
// The GFM text regex matches a first char (a run of backticks, a run of
// tildes, or any other char), then the shortest run that stops before any
// of: `\`, `<`, `!`, `[`, backtick, `*`, `~` or `_`; a protocol
// ("http://", "https://", "ftp://", any case); "www." preceded by
// whitespace, `*`, `_`, `~` or `(`; or the end of the string; or one char
// past a position where the next characters are two or more spaces and a
// newline (a hard break), a non-alphanumeric char before "mailto:"/"xmpp:",
// or a char outside the email charset before an email-looking run followed
// by "@". The first-char alternatives also stop right after the first char
// when it is followed by a hard break or an email run followed by "@".
// This scanner returns the length of exactly that match, computing the
// stop as the minimum over the candidate stops, each found with a fast
// search (a regex or indexOf) instead of a per-character loop. A rare
// trigger only matters when its stop falls before the next stop character,
// so the searches for one are bounded by it; an email run may pass through
// a stop character that is itself an email character (`_`, `*`, `!`, backtick
// or `~`), so the "@" search is not bounded by the next stop character.
// ---------------------------------------------------------------------------

function textTokenLength(s) {
  const n = s.length;
  if (n === 0) return 0;
  const c0 = s.charCodeAt(0);
  // Alternative A: a single non-alphanumeric char before mailto:/xmpp:.
  if (!isAlnum(c0) && (s.startsWith('mailto:', 1) || s.startsWith('xmpp:', 1))) {
    return 1;
  }
  // Alternative B: consume the first char.
  let p;
  if (c0 === 96) { // backtick run
    p = 1;
    while (p < n && s.charCodeAt(p) === 96) p++;
  } else if (c0 === 126) { // tilde run
    p = 1;
    while (p < n && s.charCodeAt(p) === 126) p++;
  } else {
    p = 1;
  }
  if (p >= n) return n;
  // The next stop character (or the end).
  STOP_RE.lastIndex = p;
  let stop = n;
  const m = STOP_RE.exec(s);
  if (m) stop = m.index;
  // "www." in [p, stop) with a valid lookbehind.
  let wi = s.indexOf('w', p);
  while (wi >= 0 && wi < stop) {
    if (s.startsWith('www.', wi)) {
      const prev = s.charCodeAt(wi - 1);
      if (isSpace(prev) || prev === 42 || prev === 95 || prev === 126 ||
          prev === 40) {
        stop = wi;
        break;
      }
    }
    wi = s.indexOf('w', wi + 1);
  }
  // A hard break: the first space of a run of two or more spaces and a
  // newline. A run that starts before p is the pre-lazy case: the text
  // stops at p when the run from p still holds two spaces and a newline.
  const hm = s.indexOf('  \n', p);
  if (hm >= 0) {
    let h = hm;
    while (h > 0 && s.charCodeAt(h - 1) === 32) h--;
    if (h >= p) {
      if (h < stop) stop = h;
    } else {
      let q = p;
      while (q < n && s.charCodeAt(q) === 32) q++;
      if (q - p >= 2 && s.charCodeAt(q) === 10) stop = p;
    }
  }
  // Protocols and mailto:/xmpp: are found through their ":"; the stop is a
  // few characters before it, and the first ":" that yields one gives the
  // earliest stop.
  let ci = s.indexOf(':', p);
  while (ci >= 0 && ci < stop) {
    if (s.charCodeAt(ci + 1) === 47 && s.charCodeAt(ci + 2) === 47) {
      const c1 = s.charCodeAt(ci - 1) | 32, c2 = s.charCodeAt(ci - 2) | 32,
        c3 = s.charCodeAt(ci - 3) | 32, c4 = s.charCodeAt(ci - 4) | 32,
        c5 = s.charCodeAt(ci - 5) | 32;
      if (c5 === 104 && c4 === 116 && c3 === 116 && c2 === 112 && c1 === 115) {
        if (ci - 5 >= p) { stop = ci - 5; break; } // https://
      } else if (c4 === 104 && c3 === 116 && c2 === 116 && c1 === 112) {
        if (ci - 4 >= p) { stop = ci - 4; break; } // http://
      } else if (c3 === 102 && c2 === 116 && c1 === 112) {
        if (ci - 3 >= p) { stop = ci - 3; break; } // ftp://
      }
    }
    if (ci - 6 >= 0 && s.startsWith('mailto', ci - 6)) {
      const mm = ci - 6;
      if (mm - 1 >= p && !isAlnum(s.charCodeAt(mm - 1))) { stop = mm; break; }
    } else if (ci - 4 >= 0 && s.startsWith('xmpp', ci - 4)) {
      const mm = ci - 4;
      if (mm - 1 >= p && !isAlnum(s.charCodeAt(mm - 1))) { stop = mm; break; }
    }
    ci = s.indexOf(':', ci + 1);
  }
  // An email run followed by "@": walk back from each "@" over email
  // characters; the run's start is the stop (the pre-lazy case when the
  // run starts at p). The first "@" with a non-empty run gives the
  // earliest stop.
  let a = s.indexOf('@', p);
  while (a >= 0) {
    let rs = a - 1;
    while (rs >= p && isEmailChar(s.charCodeAt(rs))) rs--;
    rs++;
    if (rs < a) {
      if (rs < stop) stop = rs;
      break;
    }
    a = s.indexOf('@', a + 1);
  }
  return stop;
}

// ---------------------------------------------------------------------------
// Trigger positions for the text token, computed once per inline pass.
// textTokenLength repeats its four searches (www., hard break, ":", "@")
// on every text token; the searches only depend on the whole source, so
// they are done once here and each text token just walks pointers that
// only move forward. Each array holds absolute positions, in order:
//   proto: starts of http://, https:// or ftp://
//   www:   positions of "www." whose preceding char is a space, *, _, ~ or (
//   hb:    starts of runs of two or more spaces ending in a newline
//   mail:  starts of "mailto:"/"xmpp:" preceded by a non-alphanumeric char
//   email: starts of the email-character run before an "@" (with a
//          non-empty run); at holds the "@" position, in parallel
// ---------------------------------------------------------------------------

function computeTriggers(src) {
  const proto = [], www = [], hb = [], mail = [], email = [], at = [];
  let wi = src.indexOf('w', 0);
  while (wi >= 0) {
    if (src.startsWith('www.', wi)) {
      const prev = src.charCodeAt(wi - 1);
      if (isSpace(prev) || prev === 42 || prev === 95 || prev === 126 ||
          prev === 40) www.push(wi);
    }
    wi = src.indexOf('w', wi + 1);
  }
  let hm = src.indexOf('  \n', 0);
  while (hm >= 0) {
    let h = hm;
    while (h > 0 && src.charCodeAt(h - 1) === 32) h--;
    if (hb.length === 0 || hb[hb.length - 1] !== h) hb.push(h);
    hm = src.indexOf('  \n', hm + 1);
  }
  let ci = src.indexOf(':', 0);
  while (ci >= 0) {
    if (src.charCodeAt(ci + 1) === 47 && src.charCodeAt(ci + 2) === 47) {
      const c1 = src.charCodeAt(ci - 1) | 32, c2 = src.charCodeAt(ci - 2) | 32,
        c3 = src.charCodeAt(ci - 3) | 32, c4 = src.charCodeAt(ci - 4) | 32,
        c5 = src.charCodeAt(ci - 5) | 32;
      if (c5 === 104 && c4 === 116 && c3 === 116 && c2 === 112 && c1 === 115) {
        proto.push(ci - 5);
      } else if (c4 === 104 && c3 === 116 && c2 === 116 && c1 === 112) {
        proto.push(ci - 4);
      } else if (c3 === 102 && c2 === 116 && c1 === 112) {
        proto.push(ci - 3);
      }
    }
    if (ci - 6 >= 0 && src.startsWith('mailto', ci - 6)) {
      const mm = ci - 6;
      if (!isAlnum(src.charCodeAt(mm - 1))) mail.push(mm);
    } else if (ci - 4 >= 0 && src.startsWith('xmpp', ci - 4)) {
      const mm = ci - 4;
      if (!isAlnum(src.charCodeAt(mm - 1))) mail.push(mm);
    }
    ci = src.indexOf(':', ci + 1);
  }
  let a = src.indexOf('@', 0);
  while (a >= 0) {
    let rs = a - 1;
    while (rs >= 0 && isEmailChar(src.charCodeAt(rs))) rs--;
    rs++;
    if (rs < a) { email.push(rs); at.push(a); }
    a = src.indexOf('@', a + 1);
  }
  return { proto, www, hb, mail, email, at };
}

// The length of the text token starting at absolute offset `off` in `src`,
// using the precomputed triggers (same result as textTokenLength on the
// remaining string). `ptr` holds the per-array pointer, advanced in place.
function textLenAt(src, off, trig, ptr) {
  const n = src.length;
  const c0 = src.charCodeAt(off);
  if (!isAlnum(c0) && (src.startsWith('mailto:', off + 1) ||
      src.startsWith('xmpp:', off + 1))) {
    return 1;
  }
  let p;
  if (c0 === 96) {
    p = off + 1;
    while (p < n && src.charCodeAt(p) === 96) p++;
  } else if (c0 === 126) {
    p = off + 1;
    while (p < n && src.charCodeAt(p) === 126) p++;
  } else {
    p = off + 1;
  }
  if (p >= n) return n - off;
  STOP_RE.lastIndex = p;
  let stop = n;
  const m = STOP_RE.exec(src);
  if (m) stop = m.index;
  const w = trig.www;
  while (ptr.wi < w.length && w[ptr.wi] < p) ptr.wi++;
  if (ptr.wi < w.length && w[ptr.wi] < stop) stop = w[ptr.wi];
  // A hard break: a run of two or more spaces and a newline starting at
  // p stops the text at p; otherwise the next run start at or after p.
  let q = p;
  while (q < n && src.charCodeAt(q) === 32) q++;
  if (q - p >= 2 && src.charCodeAt(q) === 10) {
    stop = p;
  } else {
    const h = trig.hb;
    while (ptr.hi < h.length && h[ptr.hi] < p) ptr.hi++;
    if (ptr.hi < h.length && h[ptr.hi] < stop) stop = h[ptr.hi];
  }
  const pr = trig.proto;
  while (ptr.pi < pr.length && pr[ptr.pi] < p) ptr.pi++;
  if (ptr.pi < pr.length && pr[ptr.pi] < stop) stop = pr[ptr.pi];
  const ml = trig.mail;
  while (ptr.mi < ml.length && ml[ptr.mi] <= p) ptr.mi++;
  if (ptr.mi < ml.length && ml[ptr.mi] < stop) stop = ml[ptr.mi];
  // An email run: "@" positions at or before p cannot match (the walk
  // back would be empty); the run's start is the stop, or p when the run
  // starts before p.
  const em = trig.email, at = trig.at;
  while (ptr.ei < at.length && at[ptr.ei] <= p) ptr.ei++;
  if (ptr.ei < em.length) {
    const rs = em[ptr.ei] < p ? p : em[ptr.ei];
    if (rs < stop) stop = rs;
  }
  return stop - off;
}

// ---------------------------------------------------------------------------
// Block pre-checks: necessary (not sufficient) conditions for the table and
// setext-heading regexes to match. A false positive only costs one regex
// run; a false negative would be wrong, so these stay conservative.
// ---------------------------------------------------------------------------

// The table regex needs a header line, a newline, and a delimiter line
// holding at least one "-" (its ":?-+:?" part).
function tablePossible(e) {
  const i1 = e.indexOf('\n');
  if (i1 < 0) return false;
  let nonSpace = false;
  for (let i = 0; i < i1; i++) {
    const c = e.charCodeAt(i);
    if (c !== 32 && c !== 9) { nonSpace = true; break; }
  }
  if (!nonSpace) return false;
  const i2 = e.indexOf('\n', i1 + 1);
  const d = e.indexOf('-', i1 + 1);
  return d >= 0 && (i2 < 0 || d < i2);
}

// The setext-heading regex needs an underline line ("===" or "---", up to
// three leading spaces) before the first blank line.
function lheadingPossible(e) {
  let i = e.indexOf('\n');
  if (i < 0) return false;
  let pos = i + 1;
  const n = e.length;
  while (pos < n) {
    let end = e.indexOf('\n', pos);
    if (end < 0) end = n;
    let j = pos;
    while (j < end && (e.charCodeAt(j) === 32 || e.charCodeAt(j) === 9)) j++;
    if (j === end) return false; // blank line: no underline can follow
    let k = pos;
    while (k < end && e.charCodeAt(k) === 32) k++;
    if (k - pos <= 3 && k < end) {
      const c = e.charCodeAt(k);
      if (c === 61 || c === 45) { // = or -
        let m = k + 1;
        while (m < end && e.charCodeAt(m) === c) m++;
        while (m < end && (e.charCodeAt(m) === 32 || e.charCodeAt(m) === 9)) m++;
        if (m === end) return true;
      }
    }
    pos = end + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tokenizer: only inlineText is replaced; every other tokenizer is
// marked's own, inherited unchanged.
// ---------------------------------------------------------------------------

class FastTokenizer extends Tokenizer {
  inlineText(e) {
    const len = textTokenLength(e);
    if (len === 0) return;
    const raw = e.slice(0, len);
    const inRaw = this.lexer.state.inRawBlock;
    return {
      type: 'text',
      raw,
      text: inRaw ? raw : decodeEntities(raw, this.rules.other),
      escaped: inRaw,
    };
  }

  // Marked's list tokenizer, with its per-line work made cheaper: lines are
  // taken with indexOf instead of split, the six block-start regexes of the
  // continuation loop are replaced by a first-character dispatch (only the
  // regexes a line could start can match), the leading-whitespace
  // expansion is computed only for lines that continue the item, and the
  // blank-line and indent tests are plain character scans. Every token it
  // returns is the same as marked's.
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (!t) return;
    const n = e;
    const s = () => n.length - e.length;
    const r = t[1].trim();
    const o = r.length > 1;
    const i = {
      type: 'list', raw: '', ordered: o, start: o ? +r.slice(0, -1) : '',
      loose: false, items: [],
    };
    let br = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
    if (this.options.pedantic) br = o ? br : '[*+-]';
    const l = this.rules.other.listItemRegex(br);
    let p = false;
    for (; e;) {
      let u = false, d = '';
      if (!(t = l.exec(e))) break;
      const c0 = e.charCodeAt(0);
      if ((c0 === 32 || c0 === 45 || c0 === 95 || c0 === 42) &&
          this.rules.block.hr.test(e)) break;
      const k = s();
      e = e.substring(t[0].length);
      const g = firstLine(t[2]);
      const b = t[1].length;
      const m = this.options.pedantic
        ? expandTabs(g, b)
        : g.replace(this.rules.other.leadingSpaceTab, v => expandTabs(v, b));
      const f = firstLine(e);
      let y = isBlankLine(m);
      let R = 0;
      if (this.options.pedantic) {
        R = 2;
        d = m.trimStart();
      } else if (y) {
        R = b + 1;
      } else {
        R = firstNonSpace(m);
        if (R > 4) R = 1;
        d = m.slice(R);
        R += b;
      }
      // The item text is built from pieces and joined once, so a long
      // item does not copy its text once per line.
      const parts = [d];
      if (y && isSpaceTabBlank(f)) {
        e = e.substring(f.length + 1);
        u = true;
      }
      if (!u) {
        const v = this.rules.other.nextBulletRegex(R);
        const Q = this.rules.other.hrRegex(R);
        const ee = this.rules.other.fencesBeginRegex(R);
        const te = this.options.pedantic
          ? this.rules.other.pedanticHeadingBeginRegex(R)
          : this.rules.other.headingBeginRegex(R);
        const M = this.rules.other.htmlBeginRegex(R);
        const ne = this.rules.other.blockquoteBeginRegex(R);
        const rxAll = { v, Q, ee, te, M, ne };
        const rxM = { v: null, Q, ee, te, M, ne: null };
        let mm = m;
        let prevZ = null;
        for (; e;) {
          const U = firstLine(e);
          let f2 = U, Z;
          if (this.options.pedantic) {
            f2 = f2.replace(this.rules.other.listReplaceNesting, '  ');
            Z = f2;
          }
          if (listLineBreak(f2, R, rxAll)) break;
          if (!this.options.pedantic) {
            // The leading-whitespace expansion only changes a line whose
            // leading run of spaces and tabs holds a tab.
            let Z0 = f2, k = 0;
            for (; k < f2.length; k++) {
              const c = f2.charCodeAt(k);
              if (c === 32) continue;
              if (c === 9) {
                Z0 = f2.replace(this.rules.other.leadingSpaceTab,
                  me => expandTabs(me));
              }
              break;
            }
            Z = Z0;
          }
          const fBlank = isBlankLine(f2);
          // A blank line takes the indented branch whatever its indent is,
          // so its leading spaces need no scan.
          let zIndent = -1;
          if (!fBlank) {
            let zi = 0;
            while (zi < Z.length && Z.charCodeAt(zi) === 32) zi++;
            zIndent = zi === Z.length ? -1 : zi;
          }
          if (zIndent >= R || fBlank) {
            parts.push('\n' + Z.slice(R));
          } else {
            // mm is the previous line's content after R spaces, needed
            // only here; computing it lazily skips a slice per line.
            if (prevZ !== null) mm = prevZ.slice(R);
            if (y || expandedIndent(mm) >= 4 ||
                listLineBreak(mm, R, rxM)) break;
            const qe = !this.options.pedantic && isSetextLine(f2) &&
              this.rules.block.lheading.test(`${mm}\n${f2}`)
              ? `    ${Z.replace(/^ {0,3}/, '')}` : f2;
            parts.push('\n' + qe);
          }
          y = fBlank;
          e = e.substring(U.length + 1);
          prevZ = Z;
        }
      }
      d = parts.join('');
      const A = n.slice(k, s());
      if (!i.loose) {
        if (p) i.loose = true;
        else if (endsWithBlankLine(A)) p = true;
      }
      i.items.push({
        type: 'list_item', raw: A,
        task: !!this.options.gfm && this.rules.other.listIsTask.test(d),
        loose: false, text: d, tokens: [],
      });
    }
    const h = i.items.at(-1);
    if (h) {
      h.raw = h.raw.trimEnd();
      h.text = h.text.trimEnd();
    } else return;
    i.raw = n.slice(0, s()).trimEnd();
    for (const u of i.items) {
      if (this.lexer.state.top = false,
        u.tokens = this.lexer.blockTokens(u.text, []), !i.loose) {
        const dd = u.tokens.filter(g => g.type === 'space');
        const kk = dd.length > 0 &&
          dd.some(g => this.rules.other.anyLine.test(g.raw));
        i.loose = kk;
      }
    }
    for (const u of i.items) {
      const dd = u.tokens[0];
      if (u.task && (dd?.type === 'text' || dd?.type === 'paragraph')) {
        u.text = u.text.replace(this.rules.other.listReplaceTask, '');
        dd.raw = dd.raw.replace(this.rules.other.listReplaceTask, '');
        dd.text = dd.text.replace(this.rules.other.listReplaceTask, '');
        for (let g = this.lexer.inlineQueue.length - 1; g >= 0; g--) {
          if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[g].src)) {
            this.lexer.inlineQueue[g].src =
              this.lexer.inlineQueue[g].src.replace(
                this.rules.other.listReplaceTask, '');
            break;
          }
        }
        const kk = this.rules.other.listTaskCheckbox.exec(u.raw);
        if (kk) {
          const gg = {
            type: 'checkbox', raw: kk[0] + ' ', checked: kk[0] !== '[ ]',
          };
          u.checked = gg.checked;
          if (i.loose) {
            if (u.tokens[0] &&
              ['paragraph', 'text'].includes(u.tokens[0].type) &&
              'tokens' in u.tokens[0] && u.tokens[0].tokens) {
              u.tokens[0].raw = gg.raw + u.tokens[0].raw;
              u.tokens[0].text = gg.raw + u.tokens[0].text;
              u.tokens[0].tokens.unshift(gg);
            } else {
              u.tokens.unshift({ type: 'paragraph', raw: gg.raw, text: gg.raw, tokens: [gg] });
            }
          } else u.tokens.unshift(gg);
        }
      } else if (u.task) u.task = false;
    }
    if (i.loose) {
      for (const u of i.items) {
        u.loose = true;
        for (const dd of u.tokens) {
          if (dd.type === 'text') dd.type = 'paragraph';
        }
      }
    }
    return i;
  }

  // The last possible emphasis/strikethrough closer indices in a masked
  // source, as marked's private fe() computes them. Marked recomputes
  // them on every emStrong/del call (its cache is only filled by its own
  // private wrapper, which this lexer bypasses); here they are computed
  // once per inline pass and reused.
  _closerFor(t) {
    if (this._closerMasked !== t) {
      this._closerMasked = t;
      this._closer = closerIndices(t);
    }
    return this._closer;
  }

  // Marked's emStrong, with the per-call allocations removed: the
  // character before the delimiter is read without spreading a slice,
  // the delimiter length is counted without spreading, the alnum test
  // does not allocate a match array, and the closer index comes from
  // the per-pass cache instead of a fresh scan. The logic is unchanged.
  emStrong(e, t, n = '') {
    let s = this.rules.inline.emStrongLDelim.exec(e);
    if (!s || !s[1] && !s[2] && !s[3] && !s[4]) return;
    let r = s[0][0], o = n === r, i = t.length - e.length, l = i;
    for (; !this.options.pedantic && l > 0 && t[l - 1] === r;) l--;
    let p = '';
    if (l > 0) {
      const c1 = t.charCodeAt(l - 1);
      if (c1 >= 0xDC00 && c1 <= 0xDFFF && l >= 2) {
        const c0 = t.charCodeAt(l - 2);
        p = (c0 >= 0xD800 && c0 <= 0xDBFF) ? t[l - 2] + t[l - 1] : t[l - 1];
      } else p = t[l - 1];
    }
    let h = p === '*' || p === '_' || !!this.rules.inline.punctuation.exec(p);
    l < i && (n = p);
    let u = l < i ? h : !!this.rules.inline.punctuation.exec(n);
    if (s[4] && this.rules.other.unicodeAlphaNumeric.test(n)) return;
    let d = s[1] || s[3] || '';
    if (!d || !n || u) {
      let k = codePointLength(s[0]) - 1, g, b, m = k, f = 0, y = i - l + k,
        R = !this.options.pedantic && p !== '' && !isSpace(p.charCodeAt(0)) &&
          (!!d || r === '*' && !h);
      if (r !== '*' && r !== '_') return;
      let A = r === '*' ? this.rules.inline.emStrongRDelimAst
        : this.rules.inline.emStrongRDelimUnd,
        v = this._closerFor(t).em[r], Q = t.length - e.length + k;
      if (v < Q) return;
      t = t.slice(-1 * e.length + k);
      let ee = v - Q;
      for (A.lastIndex = 0; (s = A.exec(t)) !== null && !(s.index > ee);) {
        if (g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !g) continue;
        if (b = [...g].length, s[3] || s[4]) { m += b; continue; }
        else if (s[5] || s[6] || R) {
          if (o && (s[5] || s[6])) break;
          if (y % 3 && !((y + b) % 3)) { f += b; continue; }
        }
        if (m -= b, m > 0) continue;
        b = Math.min(b, b + m + f);
        let te = [...s[0]][0].length, M = e.slice(0, k + s.index + te + b);
        if (Math.min(k, b) % 2) {
          let U = M.slice(1, -1);
          return { type: 'em', raw: M, text: U, tokens: this.lexer.inlineTokens(U) };
        }
        let ne = M.slice(2, -2);
        return { type: 'strong', raw: M, text: ne, tokens: this.lexer.inlineTokens(ne) };
      }
    }
  }

  // Marked's del, same treatment: cached closer index, delimiter length
  // counted without spreading.
  del(e, t, n = '') {
    let s = this.rules.inline.delLDelim.exec(e);
    if (!s) return;
    if (!(s[1] || '') || !n || this.rules.inline.punctuation.exec(n)) {
      let o = codePointLength(s[0]) - 1, i, l, p = o,
        h = this.rules.inline.delRDelim,
        u = this._closerFor(t).del, d = t.length - e.length + o;
      if (u < d) return;
      t = t.slice(-1 * e.length + o);
      let k = u - d;
      for (h.lastIndex = 0; (s = h.exec(t)) !== null && !(s.index > k);) {
        if (i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6],
          !i || (l = codePointLength(i), l !== o)) continue;
        if (s[3] || s[4]) { p += l; continue; }
        if (p -= l, p > 0) continue;
        l = Math.min(l, l + p);
        let g = [...s[0]][0].length, b = e.slice(0, o + s.index + g + l),
          m = b.slice(o, -o);
        return { type: 'del', raw: b, text: m, tokens: this.lexer.inlineTokens(m) };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Lexer: a faster inline loop and block loop over marked's tokenizers.
// ---------------------------------------------------------------------------

class FastLexer extends Lexer {
  // The emStrong/del mask, as marked computes it in its private #n: the
  // source with defined reference links, code spans and raw HTML masked
  // out, so emphasis closers inside them are not counted. The masking
  // preserves length, which the emStrong/del tokenizers rely on.
  _mask(e) {
    let t = e;
    if (this.tokens.links && e.includes('[')) {
      const search = this.tokenizer.rules.inline.reflinkSearch;
      const replaceFn = (r) => {
        const o = r.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(r.slice(o + 1, -1)))) {
          return r;
        }
        if (o > 1 && r.charAt(0) !== '!') {
          const inner = r.slice(1, o - 1);
          if (this.linkInText(inner)) {
            return '[' + inner.replace(search, replaceFn) + '][' +
              'a'.repeat(r.length - o - 2) + ']';
          }
        }
        return '[' + 'a'.repeat(r.length - 2) + ']';
      };
      t = t.replace(search, replaceFn);
    }
    // The punctuation/code mask can only match a backtick run or a
    // backslash-escaped punctuation character.
    if (t.includes('`') || t.includes('\\')) {
      t = t.replace(
        this.tokenizer.rules.inline.anyPunctuationOutsideCode,
        (n, s, r) => r ? '+'.repeat(n.length)
          : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
          : n,
      );
    }
    // The block-skip mask can only match a link (needs "]("), a code span
    // (needs two backticks) or an HTML tag (needs "<" and ">").
    const bi = t.indexOf('`');
    if (t.includes('](') || (bi >= 0 && t.indexOf('`', bi + 1) >= 0) ||
        (t.includes('<') && t.includes('>'))) {
      t = t.replace(this.tokenizer.rules.inline.blockSkip, (n, s, r) => {
        const o = r ? r.length : 0;
        return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
      });
    }
    t = this.options.hooks?.emStrongMask?.call({ lexer: this }, t) ?? t;
    return t;
  }

  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && e.includes(')');
    try {
      return this._inlineLoop(e, t);
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  _inlineLoop(e, tokens) {
    // The closer cache is scratch for this pass only.
    this.tokenizer._closerMasked = null;
    this.tokenizer._closer = null;
    // Emphasis and strikethrough can only match when the source holds one
    // of *, _ or ~; without them the mask is the source itself.
    const masked = (e.includes('*') || e.includes('_') || e.includes('~'))
      ? this._mask(e) : e;
    // The text-token triggers, computed once for the whole source.
    const src = e;
    const trig = computeTriggers(src);
    const ptr = { wi: 0, hi: 0, pi: 0, mi: 0, ei: 0 };
    // Extensions are checked once, not on every token.
    const inlineExt = this.options.extensions?.inline;
    const startInlineExt = this.options.extensions?.startInline;
    let s = false; // whether the previous token was text
    let r = ''; // last char of the previous text token ("" when it ended in _)
    let o = Infinity;
    for (; e;) {
      if (e.length < o) o = e.length;
      else { this.infiniteLoopError(e.charCodeAt(0)); break; }
      if (!s) r = '';
      s = false;
      let i;
      if (inlineExt?.some(p =>
        (i = p.call({ lexer: this }, e, tokens))
          ? (e = e.substring(i.raw.length), tokens.push(i), !0) : !1)) {
        continue;
      }
      const c = e.charCodeAt(0);
      if (c === 92) { // backslash: escape, or a hard break "\↵"
        i = this.tokenizer.escape(e);
        if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
        if (e.charCodeAt(1) === 10) {
          i = this.tokenizer.br(e);
          if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
        }
      } else if (c === 60) { // <: tag, then autolink
        i = this.tokenizer.tag(e);
        if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
        i = this.tokenizer.autolink(e);
        if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
      } else if (c === 91 || c === 33) { // [ or !: link, then reference link
        i = this.tokenizer.link(e);
        if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
        i = this.tokenizer.reflink(e, this.tokens.links);
        if (i) {
          e = e.substring(i.raw.length);
          const p = tokens.at(-1);
          if (i.type === 'text' && p?.type === 'text') {
            p.raw += i.raw; p.text += i.text;
          } else tokens.push(i);
          continue;
        }
      } else if (c === 42 || c === 95) { // * or _: emphasis, then (for _) a URL
        i = this.tokenizer.emStrong(e, masked, r);
        if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
        if (c === 95 && !this.state.inLink) {
          i = this.tokenizer.url(e);
          if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
        }
      } else if (c === 96) { // backtick: code span
        i = this.tokenizer.codespan(e);
        if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
      } else if (c === 32) { // space: a hard break needs a second space
        if (e.charCodeAt(1) === 32) {
          i = this.tokenizer.br(e);
          if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
        }
      } else if (c === 126) { // ~: strikethrough
        i = this.tokenizer.del(e, masked, r);
        if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
      } else if (!this.state.inLink &&
          (isAlnum(c) || c === 46 || c === 43 || c === 45)) {
        // A URL or email address can only start with [A-Za-z0-9._+-].
        i = this.tokenizer.url(e);
        if (i) { e = e.substring(i.raw.length); tokens.push(i); continue; }
      }
      let l = e;
      if (startInlineExt) {
        let p = Infinity;
        const h = e.slice(1);
        let u;
        this.options.extensions.startInline.forEach(d => {
          u = d.call({ lexer: this }, h);
          if (typeof u === 'number' && u >= 0) p = Math.min(p, u);
        });
        if (p < Infinity && p >= 0) l = e.substring(0, p + 1);
        i = this.tokenizer.inlineText(l);
      } else {
        // The text token, from the precomputed triggers: the same token
        // inlineText would build, without re-searching the source.
        const off = src.length - e.length;
        const len = textLenAt(src, off, trig, ptr);
        const raw = src.slice(off, off + len);
        const inRaw = this.state.inRawBlock;
        i = {
          type: 'text', raw,
          text: inRaw ? raw : decodeEntities(raw, this.tokenizer.rules.other),
          escaped: inRaw,
        };
      }
      if (i) {
        e = e.substring(i.raw.length);
        if (i.raw.slice(-1) !== '_') r = i.raw.slice(-1);
        s = true;
        const p = tokens.at(-1);
        if (p?.type === 'text') { p.raw += i.raw; p.text += i.text; }
        else tokens.push(i);
        continue;
      }
      if (e) { this.infiniteLoopError(e.charCodeAt(0)); break; }
    }
    return tokens;
  }

  blockTokens(e, t = [], n = false) {
    this.tokenizer.lexer = this;
    if (this.options.pedantic) {
      e = e.replace(/\t/g, '    ').replace(/^ +$/gm, '');
    }
    let s = Infinity;
    for (; e;) {
      if (e.length < s) s = e.length;
      else { this.infiniteLoopError(e.charCodeAt(0)); break; }
      const c0 = e.charCodeAt(0);
      let r;
      if (this.options.extensions?.block?.some(i =>
        (r = i.call({ lexer: this }, e, t))
          ? (e = e.substring(r.raw.length), t.push(r), !0) : !1)) {
        continue;
      }
      // Blank lines and leading newlines.
      if ((c0 === 32 || c0 === 9 || c0 === 10) && (r = this.tokenizer.space(e))) {
        e = e.substring(r.raw.length);
        const i = t.at(-1);
        if (r.raw.length === 1 && i !== void 0) i.raw += '\n';
        else t.push(r);
        continue;
      }
      // Indented code needs a leading space or tab.
      if ((c0 === 32 || c0 === 9) && (r = this.tokenizer.code(e))) {
        e = e.substring(r.raw.length);
        const i = t.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.at(-1).src = i.text;
        } else t.push(r);
        continue;
      }
      // Fences need a space, backtick or tilde first.
      if ((c0 === 32 || c0 === 96 || c0 === 126) && (r = this.tokenizer.fences(e))) {
        e = e.substring(r.raw.length); t.push(r); continue;
      }
      // ATX headings need a space or # first.
      if ((c0 === 32 || c0 === 35) && (r = this.tokenizer.heading(e))) {
        e = e.substring(r.raw.length); t.push(r); continue;
      }
      // Thematic breaks need a space, -, _ or * first.
      if ((c0 === 32 || c0 === 45 || c0 === 95 || c0 === 42) &&
          (r = this.tokenizer.hr(e))) {
        e = e.substring(r.raw.length); t.push(r); continue;
      }
      // Block quotes need a space or > first.
      if ((c0 === 32 || c0 === 62) && (r = this.tokenizer.blockquote(e))) {
        e = e.substring(r.raw.length); t.push(r); continue;
      }
      // Lists need a space, *, +, - or digit first.
      if ((c0 === 32 || c0 === 42 || c0 === 43 || c0 === 45 ||
          (c0 >= 48 && c0 <= 57)) && (r = this.tokenizer.list(e))) {
        e = e.substring(r.raw.length); t.push(r); continue;
      }
      // Raw HTML blocks need a space or < first.
      if ((c0 === 32 || c0 === 60) && (r = this.tokenizer.html(e))) {
        e = e.substring(r.raw.length); t.push(r); continue;
      }
      // Link reference definitions need a space or [ first.
      if ((c0 === 32 || c0 === 91) && (r = this.tokenizer.def(e))) {
        e = e.substring(r.raw.length);
        const i = t.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.raw;
          this.inlineQueue.at(-1).src = i.text;
        } else {
          if (!this.tokens.links[r.tag]) {
            this.tokens.links[r.tag] = { href: r.href, title: r.title };
          }
          t.push(r);
        }
        continue;
      }
      // Tables need a header line and a delimiter line holding a "-".
      if (c0 !== 10 && tablePossible(e) && (r = this.tokenizer.table(e))) {
        e = e.substring(r.raw.length); t.push(r); continue;
      }
      // Setext headings need an underline line before the next blank line.
      if (c0 !== 10 && lheadingPossible(e) && (r = this.tokenizer.lheading(e))) {
        e = e.substring(r.raw.length); t.push(r); continue;
      }
      let o = e;
      if (this.options.extensions?.startBlock) {
        let i = Infinity;
        const l = e.slice(1);
        let p;
        this.options.extensions.startBlock.forEach(h => {
          p = h.call({ lexer: this }, l);
          if (typeof p === 'number' && p >= 0) i = Math.min(i, p);
        });
        if (i < Infinity && i >= 0) o = e.substring(0, i + 1);
      }
      if (this.state.top && (r = this.tokenizer.paragraph(o))) {
        const i = t.at(-1);
        if (n && i?.type === 'paragraph') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = i.text;
        } else t.push(r);
        n = o.length !== e.length;
        e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        const i = t.at(-1);
        if (i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = i.text;
        } else t.push(r);
        continue;
      }
      if (e) { this.infiniteLoopError(e.charCodeAt(0)); break; }
    }
    return this.state.top = true, t;
  }
}

// ---------------------------------------------------------------------------
// Entry point: marked's defaults, with our tokenizer. One shared options
// object is reused across calls; it carries no per-case state (each parse
// builds a fresh lexer and parser, and the tokenizer's lexer/rules are
// reset by the lexer constructor on every call).
// ---------------------------------------------------------------------------

const sharedOptions = {
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

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const lexer = new FastLexer(sharedOptions);
  const tokens = lexer.lex(markdown);
  return new Parser(sharedOptions).parse(tokens);
}

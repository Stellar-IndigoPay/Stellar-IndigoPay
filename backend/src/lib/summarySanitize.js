"use strict";

/**
 * lib/summarySanitize.js
 *
 * Prompt-injection and output-sanitization guards for the AI project-summary
 * feature.
 *
 * Project-controlled text (name, category, description) is *untrusted data*:
 * a project owner can put instructions into the description to steer the
 * model. The model's output is equally untrusted and is stored then served to
 * donors. This module:
 *
 *   1. Frames untrusted input in explicit, typed delimiters so the model can
 *      tell data apart from instructions, and strips control characters and
 *      HTML so a project cannot break out of the framing.
 *   2. Strips markdown/HTML artifacts and enforces a length bound on the
 *      generated summary before it is persisted or served.
 */

// Backstop on stored/served summary length. `max_tokens: 400` already bounds
// the model output; this caps the sanitized string so a misbehaving model (or
// a prompt-injected one) cannot stash a large payload in the project row.
const MAX_SUMMARY_LENGTH = 1200;

// Any HTML tag. Removes <script>, <img onerror=…>, etc. and prevents input
// from injecting a closing delimiter such as `</project_data>`.
const HTML_TAG = /<[^>]*>/g;

// Markdown constructs the system prompt already forbids. Stripped here as
// defence-in-depth so a prompt-injected model cannot store markdown/HTML.
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`\n]*)`/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
// Heading/emphasis/blockquote/list markers at the start of a word.
const BLOCK_MARKER = /(^|\s)(?:#{1,6}|[*_~>])\s*/g;
// Residual markdown punctuation.
const MARKDOWN_PUNCT = /[*_~`#>|]/g;

/**
 * Strip control characters, leaving newlines/tabs intact (they are collapsed
 * later by callers). Implemented with char codes (not a regex) so the
 * `no-control-regex` ESLint rule stays satisfied.
 * @param {*} value
 * @returns {string}
 */
function stripControlChars(value) {
  const str = String(value == null ? "" : value);
  let out = "";
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    // Keep tab (9) and newline (10); drop other C0 controls and DEL (127).
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    out += str[i];
  }
  return out;
}

/**
 * Prepare a single project field for inclusion in the prompt. Strips control
 * characters and HTML so a project cannot inject a closing delimiter or a
 * script tag into the prompt framing.
 *
 * @param {*} value field value
 * @param {{ singleLine?: boolean }} [opts] collapse newlines/tabs for short fields
 * @returns {string}
 */
function sanitizePromptField(value, { singleLine = false } = {}) {
  let out = stripControlChars(value).replace(HTML_TAG, " ");
  if (singleLine) {
    out = out.replace(/[\r\n\t]+/g, " ").trim();
  } else {
    out = out.trim();
  }
  return out;
}

/**
 * Frame untrusted project data in explicit, typed delimiters. The system
 * prompt instructs the model to treat everything inside these delimiters as
 * data, never as instructions.
 *
 * @param {{ name: string, category: string, description: string }} project
 * @returns {string}
 */
function buildUserPrompt(project) {
  const name = sanitizePromptField(project.name, { singleLine: true });
  const category = sanitizePromptField(project.category, { singleLine: true });
  const description = sanitizePromptField(project.description);
  return (
    "<project_data>\n" +
    `  <name>${name}</name>\n` +
    `  <category>${category}</category>\n` +
    `  <description>\n${description}\n  </description>\n` +
    "</project_data>"
  );
}

/**
 * Sanitize a model-generated summary before it is stored or served.
 *
 * Removes HTML, markdown artifacts, and control characters; collapses
 * whitespace; and truncates to {@link MAX_SUMMARY_LENGTH}. Returns the empty
 * string when nothing usable remains (e.g. a summary that was only a script
 * tag), which callers treat as a policy failure.
 *
 * @param {*} text
 * @returns {string}
 */
function sanitizeSummary(text) {
  let out = stripControlChars(text);

  // Strip HTML first so markdown patterns don't see tag internals.
  out = out.replace(HTML_TAG, " ");

  // Links keep their visible label; images and code fences are dropped.
  out = out.replace(LINK, "$1");
  out = out.replace(IMAGE, " ");
  out = out.replace(FENCED_CODE, " ");
  out = out.replace(INLINE_CODE, "$1");

  // Heading/emphasis/blockquote markers, then any residual markdown.
  out = out.replace(BLOCK_MARKER, "$1");
  out = out.replace(MARKDOWN_PUNCT, " ");

  out = out.replace(/\s+/g, " ").trim();

  if (out.length > MAX_SUMMARY_LENGTH) {
    out = out.slice(0, MAX_SUMMARY_LENGTH).trim();
  }
  return out;
}

module.exports = {
  MAX_SUMMARY_LENGTH,
  buildUserPrompt,
  sanitizePromptField,
  sanitizeSummary,
};

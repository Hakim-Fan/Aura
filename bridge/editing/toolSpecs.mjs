export const readFileToolSpec = {
  source: 'builtin',
  name: 'read_file',
  aliases: ['read', 'readfile', 'cat'],
  description: 'Read a text file from inside the workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path inside the workspace.',
      },
      startLine: {
        type: 'number',
        description: 'Optional 1-based first line to read.',
      },
      endLine: {
        type: 'number',
        description: 'Optional 1-based last line to read.',
      },
      lineNumbers: {
        type: 'boolean',
        description:
          'Include line numbers when reading a range. Defaults to true for ranged reads.',
      },
      mode: {
        type: 'string',
        enum: ['raw', 'display', 'edit_context'],
        description:
          'Optional output mode. Use raw for copyable text, display for L-prefixed line numbers, and edit_context for structured text plus line range metadata.',
      },
    },
    required: ['path'],
  },
}

export const readBlockToolSpec = {
  source: 'builtin',
  name: 'read_block',
  aliases: ['readblock', 'read_symbol', 'read_context'],
  description:
    'Read an indentation-based code block around an anchor line or anchor text. Use this before editing a function, component, or object section when exact line ranges are uncertain.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path inside the workspace.',
      },
      anchorLine: {
        type: 'number',
        description: '1-based line near or inside the target block.',
      },
      anchorText: {
        type: 'string',
        description:
          'Text to locate when the line number is unknown. Prefer a unique symbol or heading.',
      },
      contextLines: {
        type: 'number',
        description:
          'Optional extra lines before and after the detected block, default 0 and max 20.',
      },
      maxLines: {
        type: 'number',
        description:
          'Maximum lines to return from the detected block, default 160 and max 500.',
      },
    },
    required: ['path'],
  },
}

export const applyPatchToolSpec = {
  source: 'builtin',
  name: 'apply_patch',
  aliases: ['patch'],
  approvalCategory: 'file_write',
  description:
    'Apply a structured multi-file patch inside the workspace. Prefer this for modifying existing files. Pass a patch string that starts with "*** Begin Patch" and ends with "*** End Patch"; tolerant runtimes may also forward a raw/freeform patch body directly.',
  inputSchema: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description:
          'Structured patch text using "*** Begin Patch", "*** Update File:", "*** Add File:", "*** Delete File:", "@@" hunks, and "*** End Patch".',
      },
      input: {
        type: 'string',
        description:
          'Compatibility alias for patch. Use patch for new calls.',
      },
      command: {
        type: 'string',
        description:
          'Compatibility alias for patch text when a caller forwards an apply_patch shell command body.',
      },
      content: {
        type: 'string',
        description:
          'Compatibility alias for patch. Use patch for new calls.',
      },
    },
  },
}

export const writeFileToolSpec = {
  source: 'builtin',
  name: 'write_file',
  aliases: ['write', 'writefile'],
  approvalCategory: 'file_write',
  description:
    'Write a text file inside the workspace. Best for new files or full-document rewrites.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path inside the workspace.',
      },
      content: {
        type: 'string',
        description: 'Full text content to write.',
      },
    },
    required: ['path', 'content'],
  },
}

export const editFileToolSpec = {
  source: 'builtin',
  name: 'edit_file',
  aliases: ['edit', 'replace'],
  approvalCategory: 'file_write',
  description:
    'Edit a file by replacing an exact text block. Use this as a fallback when apply_patch would be overkill. If exact text matching fails after reading a line range, use replace_line_range instead.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path inside the workspace.',
      },
      oldText: {
        type: 'string',
        description: 'Exact text to replace.',
      },
      newText: {
        type: 'string',
        description: 'Replacement text.',
      },
      replaceAll: {
        type: 'boolean',
        description: 'Replace every occurrence instead of only the first one.',
      },
      expectedReplacements: {
        type: 'number',
        description: 'Optional minimum number of occurrences expected before editing.',
      },
    },
    required: ['path', 'oldText', 'newText'],
  },
}

export const replaceLineRangeToolSpec = {
  source: 'builtin',
  name: 'replace_line_range',
  aliases: ['edit_range', 'replace_lines'],
  approvalCategory: 'file_write',
  description:
    'Replace an inclusive 1-based line range in a workspace text file. Use this after read_file with startLine/endLine when apply_patch or exact edit_file context does not match. Content must not include line-number prefixes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path inside the workspace.',
      },
      startLine: {
        type: 'number',
        description: 'Inclusive 1-based first line to replace.',
      },
      endLine: {
        type: 'number',
        description: 'Inclusive 1-based last line to replace.',
      },
      content: {
        type: 'string',
        description:
          'Replacement text for the selected line range, without read_file line-number prefixes.',
      },
      expectedText: {
        type: 'string',
        description:
          'Optional exact text expected in the selected range before writing.',
      },
    },
    required: ['path', 'startLine', 'endLine', 'content'],
  },
}

export const multiEditFileToolSpec = {
  source: 'builtin',
  name: 'multi_edit_file',
  aliases: ['multiedit', 'editmany'],
  approvalCategory: 'file_write',
  description:
    'Apply multiple exact text replacements to one file in sequence. Use this only when apply_patch is unnecessary and several exact replacements are clearer.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative file path inside the workspace.',
      },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string' },
            newText: { type: 'string' },
            replaceAll: { type: 'boolean' },
            expectedReplacements: { type: 'number' },
          },
          required: ['oldText', 'newText'],
        },
        description: 'Ordered list of exact replacements to apply.',
      },
    },
    required: ['path', 'edits'],
  },
}

export const searchCodeToolSpec = {
  source: 'builtin',
  name: 'search_code',
  aliases: ['search', 'grep', 'ripgrep'],
  description:
    'Search the workspace using ripgrep and return matches with suggested read_file ranges that can be read directly with mode=edit_context.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query for ripgrep.',
      },
      path: {
        type: 'string',
        description: 'Optional relative path inside the workspace.',
      },
      format: {
        type: 'string',
        enum: ['structured', 'text'],
        description:
          'Output format. structured returns matches and suggestedRanges; text keeps a ripgrep-like listing plus read_file hints. Defaults to structured.',
      },
      contextLines: {
        type: 'number',
        description:
          'Number of lines before/after each match to include in suggested read ranges. Default 8, max 80.',
      },
      maxMatches: {
        type: 'number',
        description: 'Maximum matches to return. Default 200, max 500.',
      },
    },
    required: ['query'],
  },
}

export const verifyArtifactToolSpec = {
  source: 'builtin',
  name: 'verify_artifact',
  aliases: ['verify_file', 'verify_output', 'inspect_artifact'],
  description:
    'Verify that an output artifact exists, can be read back, has a recorded hash, and has the expected container structure for DOCX, PPTX, or XLSX files.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative artifact path inside the workspace.',
      },
      expectedKind: {
        type: 'string',
        enum: ['docx', 'pptx', 'xlsx', 'pdf', 'png', 'jpeg', 'file'],
        description:
          'Optional expected artifact kind. For Office files, this also validates the expected OOXML container entries.',
      },
    },
    required: ['path'],
  },
}

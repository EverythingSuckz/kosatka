//  @ts-check

/** @type {import('prettier').Config} */
const config = {
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  // Accept either line ending. Git's autocrlf checks files out as CRLF on
  // Windows, and we don't want prettier flagging every file for it.
  endOfLine: 'auto',
}

export default config

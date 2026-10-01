// Unicorn (.u) language registration for Monaco: file association,
// bracket/comment config, and first-pass Monarch highlighting. The
// `uni lsp` semantic tokens refine these colors once the server
// attaches; this layer keeps plain viewing readable without it.
function registerUnicornLanguage() {
  if (typeof monaco === "undefined") return;
  if (registerUnicornLanguage.done) return;
  registerUnicornLanguage.done = true;

  monaco.languages.register({ id: "unicorn", extensions: [".u"], aliases: ["Unicorn", "unicorn"] });
  monaco.languages.setLanguageConfiguration("unicorn", {
    comments: { lineComment: "#" },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });
  monaco.languages.setMonarchTokensProvider("unicorn", {
    keywords: [
      "class", "tag", "type", "print", "cond", "return", "pass",
      "todo", "native", "specs", "example", "rules", "steps", "conformance",
      "state", "expect_state", "valid", "invalid",
      "if", "then", "and", "or", "not",
    ],
    constants: ["true", "false", "null"],
    typeKeywords: ["Int", "Float", "Str", "Bool", "Bytes", "Any", "List", "Map", "Fn"],
    escapes: /\\(?:[nrt\\"']|u[0-9A-Fa-f]{4})/,
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/"/, "string", "@dstring"],
        [/'/, "string", "@sstring"],
        // Output arms and match arms start the line: -Found, -true.
        [/^(\s*)(-)(\w+)/, ["", "operator", "type"]],
        // Method definitions and calls: .greet, Qual.greet via the name rule.
        [/(\.)([A-Za-z_]\w*)/, ["delimiter", "type"]],
        [/\d+\.\d+/, "number"],
        [/\d+/, "number"],
        // Capitalized names (classes, types, outputs) read as types;
        // no keyword starts uppercase so this rule comes first.
        [/[A-Z]\w*/, "type"],
        [/[A-Za-z_]\w*/, {
          cases: {
            "@keywords": "keyword",
            "@constants": "keyword",
            "@typeKeywords": "type",
            "@default": "identifier",
          },
        }],
        [/=>|->|==|!=|<=|>=|\.\.\.|[+\-*/%=<>!?:&|]/, "operator"],
        [/[{}\]()[\]]/, "@brackets"],
        [/[,;]/, "delimiter"],
      ],
      dstring: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, "string", "@pop"],
      ],
      sstring: [
        [/[^\\']+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/'/, "string", "@pop"],
      ],
    },
  });
}

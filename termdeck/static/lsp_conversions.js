class TermdeckLspConversions {
  toMonacoRange(range) {
    if (!range?.start || !range?.end) return null;
    return new monaco.Range(range.start.line + 1, range.start.character + 1, range.end.line + 1, range.end.character + 1);
  }

  lspLocationParts(location) {
    const uri = location?.uri || location?.targetUri;
    const range = location?.targetSelectionRange || location?.range || location?.targetRange;
    return uri && range ? { uri, range } : null;
  }

  toMonacoLocation(location) {
    const parts = this.lspLocationParts(location);
    if (!parts) return null;
    const range = this.toMonacoRange(parts.range);
    return range ? { uri: monaco.Uri.parse(parts.uri), range } : null;
  }

  normalizeLocations(result) {
    const locations = Array.isArray(result) ? result : result ? [result] : [];
    return locations.map((location) => this.toMonacoLocation(location)).filter(Boolean);
  }

  hoverContents(contents) {
    const values = Array.isArray(contents) ? contents : [contents];
    return values.filter(Boolean).map((value) => {
      if (typeof value === "string") return { value };
      if (typeof value.value === "string" && value.language) return { value: `\`\`\`${value.language}\n${value.value}\n\`\`\`` };
      return { value: String(value.value || "") };
    }).filter((value) => value.value);
  }

  toLspRange(range) {
    return { start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
      end: { line: range.endLineNumber - 1, character: range.endColumn - 1 } };
  }

  diagnosticSeverity(severity) {
    return ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning,
      3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint })[severity] || monaco.MarkerSeverity.Info;
  }

  lspDiagnosticSeverity(severity) {
    if (severity === monaco.MarkerSeverity.Error) return 1;
    if (severity === monaco.MarkerSeverity.Warning) return 2;
    if (severity === monaco.MarkerSeverity.Hint) return 4;
    return 3;
  }
}

window.TermdeckLspConversions = TermdeckLspConversions;

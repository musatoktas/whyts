const safe = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

export function renderReport(report, color = false) {
  const bold = s => color ? `\u001b[1m${s}\u001b[0m` : s;
  const lines = [bold('whyts'), `TypeScript ${report.typescriptVersion} · ${safe(report.project)}`, ''];
  const total = report.diagnostics['Total time'];
  const check = report.diagnostics['Check time'];
  lines.push(`Compiler: ${total ? total.value.toFixed(2) + 's' : 'n/a'} · Check: ${check ? check.value.toFixed(2) + 's' : 'n/a'} · Program files: ${report.summary.programFiles}`);
  lines.push('Fresh cache · no emit · tracing enabled');
  if (report.summary.compilerExitCode !== 0) lines.push(`Compiler exited ${report.summary.compilerExitCode} with ${report.summary.errorCount} reported errors. Fix errors before comparing timings.`);
  lines.push('', bold(`${report.findings.length} findings`));
  if (!report.findings.length) lines.push('No configured heuristic matched. This does not establish that the project is fast.');
  for (const [i, finding] of report.findings.entries()) {
    lines.push('', bold(`${i + 1}. [${finding.confidence}] ${safe(finding.title)}`));
    if (finding.evidence.include) lines.push(`   include: ${finding.evidence.include.map(safe).join(', ')}`);
    if (finding.evidence.files) lines.push(...finding.evidence.files.map(f => `   ${safe(f)}`));
    if (finding.evidence.copies) lines.push(...finding.evidence.copies.map(c => `   ${safe(c.version)} at ${safe(c.path)}`));
    lines.push(`   ${finding.suggestion}`);
  }
  if (report.hotspots.length) {
    lines.push('', bold('Largest recorded file-check intervals'));
    for (const h of report.hotspots) lines.push(`   ${h.milliseconds.toFixed(1).padStart(8)} ms  ${safe(h.file)}`);
  }
  lines.push('', ...report.warnings.map(w => `Note: ${w}`), '', 'Why is a file included? whyts explain <file> --project <tsconfig>');
  return lines.join('\n') + '\n';
}

export function renderExplanation(result) {
  const lines = [`whyts explain ${safe(result.file)}`, ''];
  if (result.configuredRoot) lines.push('Included as a configured root through files/include/default inclusion.');
  else if (result.chain.length) lines.push('One shortest observed import/reference chain:', ...result.chain.map((p, i) => `${'  '.repeat(i)}${i ? '→ ' : ''}${safe(p)}`));
  if (result.importedBy.length) lines.push('', 'Direct importers:', ...result.importedBy.map(p => `  ${safe(p)}`));
  if (result.note) lines.push('', result.note);
  return lines.join('\n') + '\n';
}

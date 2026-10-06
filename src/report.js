const safe = text => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

function typeDescription(type) {
  const details = [...(type.flags ?? [])];
  if (type.unionMembers !== undefined) details.push(`${type.unionMembers} union members`);
  if (type.intersectionMembers !== undefined) details.push(`${type.intersectionMembers} intersection members`);
  const declaration = type.declaration;
  return `${safe(type.label)} (#${type.id})${details.length ? ' [' + details.map(safe).join(', ') + ']' : ''}` +
    (declaration ? ` at ${safe(declaration.file)}:${declaration.line}:${declaration.character} [${declaration.scope}]${declaration.locationKind === 'trace' ? ' (raw trace position)' : ''}` : '');
}

function comparisonLines(comparison) {
  const duration = comparison.milliseconds > 0 && comparison.milliseconds < 0.1 ? '<0.1' : comparison.milliseconds.toFixed(1);
  return [`   ${duration} ms recorded type comparison (inclusive)`,
    `     source: ${typeDescription(comparison.source)}`, `     target: ${typeDescription(comparison.target)}`];
}

const shareNote = h => h.checkTimeShareUpperBoundPercent != null ? `  (at most ${h.checkTimeShareUpperBoundPercent}% of Check)` : '';

export function renderReport(report, color = false) {
  const bold = s => color ? `\u001b[1m${s}\u001b[0m` : s;
  const native = report.compiler === 'native';
  const lines = [bold('whyts'), `TypeScript ${report.typescriptVersion}${native ? ' (native, EXPERIMENTAL)' : ''} · ${safe(report.project)}`];
  if (native) lines.push(`Experimental TypeScript 7 support. ${report.checkers} checker; Check time is not comparable with a default parallel tsc run.`);
  lines.push('');
  const total = report.diagnostics['Total time'];
  const check = report.diagnostics['Check time'];
  lines.push(`Compiler: ${total ? total.value.toFixed(2) + 's' : 'n/a'} · Check: ${check ? check.value.toFixed(2) + 's' : 'n/a'} · Program files: ${report.summary.programFiles}`);
  const dump = report.diagnostics['Dump types time'];
  if (report.summary.wallMilliseconds !== undefined) lines.push(`Process wall time: ${(report.summary.wallMilliseconds / 1000).toFixed(2)}s` +
    (dump ? ` · Trace type dump: ${dump.value.toFixed(2)}s (not included in Compiler total)` : ''));
  lines.push('Fresh cache · no emit · tracing enabled');
  if (report.summary.compilerExitCode !== 0) lines.push(`Compiler exited ${report.summary.compilerExitCode} with ${report.summary.errorCount} reported errors. Fix errors before comparing timings.`);
  const errors = report.compilerErrors;
  if (errors?.total) {
    lines.push(`Error codes: ${errors.codes.map(c => `${c.code} x${c.count}`).join(', ')}`);
    lines.push(`First ${errors.first.length} errors:`);
    for (const e of errors.first) lines.push(`   ${e.file ? `${safe(e.file)}${e.line ? `:${e.line}:${e.character}` : ''}  ` : ''}${e.code}  ${safe(e.message)}`);
    if (errors.measurementMayBeInvalid) lines.push(`WARNING: ${errors.missingDependencyErrors} of ${errors.total} errors are unresolved modules or type declarations. Dependencies may be missing or not built; these timings may not represent a healthy build.`);
  }
  lines.push('', bold(`${report.findings.length} findings; measured checks first`));
  if (!report.findings.length) lines.push('No finding crossed a measurement threshold or matched a structural rule. Recorded intervals remain below; this does not establish that the project is fast.');
  const measured = report.findings.filter(f => f.confidence === 'measured');
  const structural = report.findings.filter(f => f.confidence !== 'measured');
  const renderFinding = (finding, i) => {
    lines.push('', bold(`${i + 1}. [${finding.confidence}] ${safe(finding.title)}`));
    if (finding.evidence.include) lines.push(`   include: ${finding.evidence.include.map(safe).join(', ')}`);
    if (finding.evidence.files) lines.push(...finding.evidence.files.map(f => `   ${safe(f)}`));
    if (finding.evidence.copies) lines.push(...finding.evidence.copies.map(c => `   ${safe(c.version)} at ${safe(c.path)}`));
    if (finding.evidence.snippet) lines.push(`   ${safe(finding.evidence.snippet)}`);
    if (finding.evidence.scope) lines.push(`   scope: ${safe(finding.evidence.scope)}`);
    if (finding.evidence.members) {
      lines.push(`   ${finding.evidence.memberCount} source checks in one same-thread chain; durations overlap and must not be added.`);
      for (const member of finding.evidence.members) lines.push(`     ${safe(member.file)}:${member.line}:${member.character}  ${member.milliseconds.toFixed(1)} ms  ${safe(member.snippet)}`);
    }
    if (finding.evidence.comparisons) for (const comparison of finding.evidence.comparisons) lines.push(...comparisonLines(comparison));
    if (finding.evidence.alreadyRootFiles !== undefined) lines.push(`   ${finding.evidence.alreadyRootFiles} reached files are already configured roots; ${finding.evidence.directImporters} direct importers`);
    if (finding.evidence.checkTimeShareUpperBoundPercent != null) lines.push(`   at most ${finding.evidence.checkTimeShareUpperBoundPercent}% of Check time (upper bound, not a predicted saving; inclusive interval measured under tracing)`);
    if (finding.evidence.testRootsExcluded) lines.push(`   not listed: ${finding.evidence.testRootsExcluded} test/spec roots (tests are not expected to be imported)`);
    lines.push(`   ${safe(finding.suggestion)}`);
  };
  measured.forEach(renderFinding);
  if (report.projectHotspots?.length) {
    lines.push('', bold('Largest recorded project file-check intervals'));
    for (const h of report.projectHotspots) lines.push(`   ${h.milliseconds.toFixed(1).padStart(8)} ms  ${safe(h.file)}${shareNote(h)}`);
  }
  const remainingFiles = report.hotspots.filter(h => !report.projectHotspots?.some(p => p.file === h.file));
  if (remainingFiles.length) {
    lines.push('', bold(report.projectHotspots?.length ? 'Largest remaining recorded file-check intervals' : 'Largest recorded file-check intervals'));
    for (const h of remainingFiles) lines.push(`   ${h.milliseconds.toFixed(1).padStart(8)} ms  ${safe(h.file)}${shareNote(h)}`);
  }
  const covered = new Set(measured.flatMap(f => f.evidence.comparisons ?? []).map(c => `${c.source.id}:${c.target.id}`));
  const otherComparisons = (report.typeHotspots ?? []).filter(c => !covered.has(`${c.source.id}:${c.target.id}`));
  if (otherComparisons.length) {
    lines.push('', bold('Other recorded type comparisons'), '   These spans have no expression attribution in this report.');
    for (const comparison of otherComparisons) lines.push(...comparisonLines(comparison));
  }
  if (structural.length) {
    lines.push('', bold('Project structure; savings are unmeasured'));
    structural.forEach((finding, i) => renderFinding(finding, measured.length + i));
  }
  if (report.typeDescriptors?.requestedIds) lines.push('',
    `Type descriptors: ${report.typeDescriptors.resolvedIds}/${report.typeDescriptors.requestedIds} selected IDs resolved; file ${report.typeDescriptors.fileBytes ?? 'unknown'} bytes, retained ${report.typeDescriptors.retainedBytes} bytes.`);
  lines.push('', ...report.warnings.map(w => `Note: ${safe(w)}`), '', 'Why is a file included? whyts explain <file> --project <tsconfig>');
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

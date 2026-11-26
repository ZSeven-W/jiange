import { execFileSync } from 'node:child_process';

const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const standard = new Set(['README.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'Dockerfile', '.DS_Store', 'NUNITO-OFL.txt', 'Chart.yaml', 'NOTES.txt', '_helpers.tpl']);
const standardDirs = new Set(['ISSUE_TEMPLATE']);
const localizedReadme = /^README\.[a-z]{2}(?:-[A-Z]{2})?\.md$/;
const component = /^\.?[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*$/;
const goSuffix = /_(?:(?:aix|android|darwin|dragonfly|freebsd|illumos|ios|js|linux|netbsd|openbsd|plan9|solaris|wasip1|windows|386|amd64|arm|arm64|loong64|mips|mips64|mips64le|mipsle|ppc64|ppc64le|riscv64|s390x)(?:_test)?|test)\.go$/;
const errors = [];
for (const path of paths) {
  if (path.startsWith('server/internal/migrate/sql/')) continue; // Applied migration names are persistent database identifiers.
  if (localizedReadme.test(path)) continue; // Standard GitHub root localized READMEs (README.en.md, README.zh-TW.md, etc.).
  const parts = path.split('/');
  const name = parts.pop();
  for (const part of parts) if (!standardDirs.has(part) && !component.test(part)) errors.push(path);
  if (standard.has(name)) continue;
  const normalized = name.replace(goSuffix, '.go');
  if (!component.test(normalized)) errors.push(path);
}
if (errors.length) {
  process.stderr.write(`Non-kebab file names:\n${[...new Set(errors)].join('\n')}\n`);
  process.exitCode = 1;
} else console.log(`Checked ${paths.length} tracked paths; project names use kebab-case.`);

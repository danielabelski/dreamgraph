import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Shared source/source-equivalent file filter for changed-file tracking and
 * pending review diffs. The default policy intentionally ignores binaries,
 * dependency folders, build outputs, caches, VCS internals, and other noisy
 * generated artifacts under the workspace root.
 */
export class ReviewableFileFilter {
  private static readonly reviewableExtensions = new Set([
    // Code
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
    '.py', '.pyi', '.rs', '.go', '.java', '.kt', '.kts', '.scala',
    '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.cs', '.fs',
    '.php', '.rb', '.swift', '.m', '.mm', '.dart', '.lua', '.r',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',

    // Markup, docs, data, queries, config
    '.md', '.mdx', '.txt', '.rst', '.adoc', '.tex',
    '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.env',
    '.xml', '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.sql', '.graphql', '.gql', '.proto', '.csv', '.tsv',

    // Project metadata / ignore / lockfiles commonly reviewed as text
    '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
    '.prettierrc', '.eslintrc', '.babelrc', '.browserslistrc',
    '.lock'
  ]);

  private static readonly reviewableBasenames = new Set([
    'Dockerfile', 'Containerfile', 'Makefile', 'Rakefile', 'Gemfile',
    'Procfile', 'LICENSE', 'LICENCE', 'NOTICE', 'README', 'CHANGELOG',
    'CONTRIBUTING', 'CODEOWNERS', 'package-lock.json', 'pnpm-lock.yaml',
    'yarn.lock', 'Cargo.lock', 'go.sum', 'go.mod', 'poetry.lock',
    'Pipfile', 'Pipfile.lock', 'requirements.txt', 'tsconfig.json',
    'jsconfig.json'
  ]);

  private static readonly ignoredPathSegments = new Set([
    '.git', '.hg', '.svn',
    'node_modules', 'bower_components', 'vendor',
    'dist', 'out', 'build', 'target', 'coverage', '.next', '.nuxt',
    '.turbo', '.cache', '.parcel-cache', '.pytest_cache', '.mypy_cache',
    '__pycache__', '.gradle', '.idea', '.vscode-test'
  ]);

  private static readonly ignoredExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.tiff',
    '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db', '.sqlite', '.sqlite3',
    '.wasm', '.class', '.jar', '.war', '.ear', '.pyc', '.pyo', '.o', '.obj',
    '.a', '.lib', '.pdb', '.dSYM', '.map', '.mp3', '.mp4', '.mov', '.avi',
    '.woff', '.woff2', '.ttf', '.otf', '.eot'
  ]);

  static isReviewableUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file') {
      return false;
    }

    return this.isReviewablePath(uri.fsPath);
  }

  static isReviewablePath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);

    if (parts.some(part => this.ignoredPathSegments.has(part))) {
      return false;
    }

    const baseName = path.basename(filePath);
    const ext = path.extname(baseName);

    if (this.ignoredExtensions.has(ext.toLowerCase())) {
      return false;
    }

    if (this.reviewableBasenames.has(baseName)) {
      return true;
    }

    if (baseName.startsWith('.')) {
      return this.reviewableExtensions.has(baseName.toLowerCase());
    }

    return this.reviewableExtensions.has(ext.toLowerCase());
  }
}

export const TrackableFileFilter = ReviewableFileFilter;

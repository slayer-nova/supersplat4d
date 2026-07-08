// package-scene.js — build a self-contained, deployable static folder for SHARING a FlexAvatar
// scene. Given a .flexscene.json manifest + an already-built dist/, it emits a folder = the JS/CSS
// bundle + the manifest + ONLY the bakes/models the manifest references, with index.html rewritten
// to auto-open the scene in read-only player mode (?loadscene=…&player=1). Serve/host the folder.
//
//   npm run build                                  # produce dist/ first
//   node scripts/package-scene.js my.flexscene.json [--out ./share/mydemo] [--dist ./dist]
//                                                  [--manifest-name scene.flexscene.json] [--keep-eruda]

const fs = require('fs');
const path = require('path');

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
let manifestArg = null;
const opts = { dist: './dist', out: null, manifestName: 'scene.flexscene.json', keepEruda: false };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') opts.dist = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--manifest-name') opts.manifestName = argv[++i];
    else if (a === '--keep-eruda') opts.keepEruda = true;
    else if (!a.startsWith('--')) manifestArg = a;
}
if (!manifestArg) {
    console.error('Usage: node scripts/package-scene.js <scene.flexscene.json> [--out DIR] [--dist DIR] [--manifest-name NAME] [--keep-eruda]');
    process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.resolve(repoRoot, manifestArg);
const distDir = path.resolve(repoRoot, opts.dist);
const outDir = path.resolve(repoRoot, opts.out || `./dist-share/${path.basename(manifestArg).replace(/\.[^.]+$/, '')}`);

// ---- helpers -------------------------------------------------------------
const MODEL_EXT = new Set(['.sog4d', '.sog', '.ply', '.splat', '.lcc']);
const ASSET_DIRS = new Set(['bakes', 'models', 'scenes']);
const stripDot = (u) => u.replace(/^\.?\//, '');
const warnings = [];
let filesCopied = 0;
let bytesCopied = 0;

const copyFileSync = (src, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    filesCopied++;
    bytesCopied += fs.statSync(dest).size;
};
const copyDirSync = (src, dest) => {
    if (!fs.existsSync(src)) return false;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) copyDirSync(s, d);
        else copyFileSync(s, d);
    }
    return true;
};

// ---- 1. read + validate manifest ----------------------------------------
if (!fs.existsSync(manifestPath)) {
    console.error(`❌ Manifest not found: ${manifestPath}`);
    process.exit(1);
}
if (!fs.existsSync(distDir)) {
    console.error(`❌ dist/ not found at ${distDir} — run \`npm run build\` first.`);
    process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.type !== 'flexavatar-scene') {
    console.error(`❌ Not a flexavatar-scene manifest (type=${manifest.type}).`);
    process.exit(1);
}

// ---- 2. collect referenced assets (dedupe sog4d by url; skip cross-origin) --
const assets = []; // { kind:'dir'|'file', rel }
const seen = new Set();
for (const s of (manifest.sources || [])) {
    const url = s.url || '';
    if (/^https?:\/\//i.test(url)) { warnings.push(`cross-origin source kept as absolute URL (not bundled): ${url}`); continue; }
    if (seen.has(url)) continue; // dedupe (matches import: one .sog4d recreates all its sub-splats)
    seen.add(url);
    const rel = stripDot(url);
    assets.push({ kind: s.kind === 'atlas' ? 'dir' : 'file', rel });
}

// ---- 3+4. output dir + copy the bundle by EXCLUSION ----------------------
// (content-hashed chunk names change per build, so copy everything except the asset dirs and
//  root-level model files — those are copied selectively below.)
fs.mkdirSync(outDir, { recursive: true });
for (const e of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (e.isDirectory()) {
        if (ASSET_DIRS.has(e.name)) continue;
        copyDirSync(path.join(distDir, e.name), path.join(outDir, e.name));
    } else {
        if (MODEL_EXT.has(path.extname(e.name).toLowerCase())) continue;
        copyFileSync(path.join(distDir, e.name), path.join(outDir, e.name));
    }
}

// ---- 5. copy the manifest into the output root ---------------------------
fs.copyFileSync(manifestPath, path.join(outDir, opts.manifestName));

// ---- 6. copy ONLY the referenced assets, preserving their relative path ---
for (const a of assets) {
    const src = path.join(distDir, a.rel);
    const dest = path.join(outDir, a.rel);
    const ok = a.kind === 'dir' ? copyDirSync(src, dest) : (fs.existsSync(src) ? (copyFileSync(src, dest), true) : false);
    if (!ok) warnings.push(`referenced asset missing in dist (place it under public/${a.rel} and rebuild): ${a.rel}`);
}

// ---- 7. rewrite index.html: auto-open the scene in player mode + strip eruda --
const indexPath = path.join(outDir, 'index.html');
if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf8');
    const autoNav =
        `<script>(function(){var p=new URLSearchParams(location.search);` +
        `if(!p.has('loadscene')){history.replaceState(null,'',location.pathname+` +
        `'?loadscene=./${opts.manifestName}&player=1'+location.hash);}})();</script>`;
    // Strip eruda FIRST (before injecting our own <script>), and use a boundary-safe regex that
    // never spans a </script> — otherwise it would swallow everything up to eruda.init().
    if (!opts.keepEruda) {
        html = html.replace(/\s*<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/eruda"><\/script>/i, '');
        html = html.replace(/\s*<script>(?:(?!<\/script>)[\s\S])*?eruda\.init\(\)(?:(?!<\/script>)[\s\S])*?<\/script>/i, '');
    }
    // insert the classic (non-deferred) auto-nav script right after <base ...> (falls back to <head>)
    if (/<base[^>]*>/i.test(html)) html = html.replace(/(<base[^>]*>)/i, `$1\n        ${autoNav}`);
    else html = html.replace(/(<head[^>]*>)/i, `$1\n        ${autoNav}`);
    fs.writeFileSync(indexPath, html);
} else {
    warnings.push('index.html not found in dist — bundle may be incomplete.');
}

// ---- 8. summary ----------------------------------------------------------
const mb = (bytesCopied / (1024 * 1024)).toFixed(1);
console.log(`\n📦 Packaged scene → ${outDir}`);
console.log(`   ${filesCopied} files, ${mb} MB`);
console.log(`   assets: ${assets.map(a => a.rel).join(', ') || '(none)'}`);
if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`   - ${w}`));
}
console.log(`\n✨ Serve it:  npx serve "${path.relative(repoRoot, outDir)}" -C   (opens the scene in player mode)`);

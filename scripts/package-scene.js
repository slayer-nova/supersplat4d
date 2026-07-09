// package-scene.js — build a self-contained, deployable static folder for SHARING a FlexAvatar
// scene. Given a .flexscene.json manifest + an already-built dist/, it emits a folder = the JS/CSS
// bundle + the manifest + ONLY the bakes/models the manifest references, with index.html rewritten
// to auto-open the scene in read-only player mode (?loadscene=…&player=1). Serve/host the folder.
//
// Static (non-4D) sources are SHRUNK by compressing a raw .ply → .sog (SuperSplat's SOG v2, a
// zip of meta.json + lossless WebP) via the fork's ply_to_sog4d.py; the editor loads .sog natively
// (engine gsplat loader). Atlas (mp4) and sog4d sources are already compressed and copied as-is.
//
//   npm run build                                  # produce dist/ first
//   node scripts/package-scene.js my.flexscene.json [--out ./share/mydemo] [--dist ./dist]
//                                                  [--manifest-name scene.flexscene.json] [--keep-eruda]
//                                                  [--no-sog] [--python PATH] [--sog-script PATH]
//
// SOG compression needs Python with numpy/plyfile/pillow/scikit-learn (the FlexAvatar conda env).
// Point --python at it (or set FLEXAVATAR_PYTHON); if conversion fails, the raw .ply is copied and a
// warning is printed — packaging never aborts over one source.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
let manifestArg = null;
const opts = {
    dist: './dist', out: null, manifestName: 'scene.flexscene.json', keepEruda: false,
    sog: true, python: process.env.FLEXAVATAR_PYTHON || 'python', sogScript: null
};
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') opts.dist = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--manifest-name') opts.manifestName = argv[++i];
    else if (a === '--keep-eruda') opts.keepEruda = true;
    else if (a === '--no-sog') opts.sog = false;
    else if (a === '--python') opts.python = argv[++i];
    else if (a === '--sog-script') opts.sogScript = argv[++i];
    else if (!a.startsWith('--')) manifestArg = a;
}
if (!manifestArg) {
    console.error('Usage: node scripts/package-scene.js <scene.flexscene.json> [--out DIR] [--dist DIR] [--manifest-name NAME] [--keep-eruda] [--no-sog] [--python PATH] [--sog-script PATH]');
    process.exit(1);
}

const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.resolve(repoRoot, manifestArg);
const distDir = path.resolve(repoRoot, opts.dist);
const outDir = path.resolve(repoRoot, opts.out || `./dist-share/${path.basename(manifestArg).replace(/\.[^.]+$/, '')}`);
const sogScript = opts.sogScript ? path.resolve(repoRoot, opts.sogScript) : path.join(repoRoot, 'ply_to_sog4d.py');

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

// Compress a raw static .ply -> .sog via ply_to_sog4d.py. Returns bytes written, or 0 on any failure
// (missing script/python, subprocess error, no output) — the caller then copies the raw .ply.
const tryConvertSog = (srcPly, destSog) => {
    if (!fs.existsSync(sogScript)) {
        warnings.push(`SOG script not found at ${path.relative(repoRoot, sogScript)} — copied raw .ply`);
        return 0;
    }
    try {
        fs.mkdirSync(path.dirname(destSog), { recursive: true });
        execFileSync(opts.python, [sogScript, '--ply', srcPly, '-o', destSog], { stdio: 'pipe' });
        if (!fs.existsSync(destSog)) return 0;
        const sz = fs.statSync(destSog).size;
        filesCopied++;
        bytesCopied += sz;
        return sz;
    } catch (e) {
        const tail = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n').slice(-2).join(' ');
        warnings.push(`SOG conversion failed (${opts.python}) — copied raw .ply: ${tail}`);
        return 0;
    }
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

// ---- 2. classify referenced sources (dedupe by url; skip cross-origin) ----
//   atlas                       -> copy the bake dir as-is (mp4 already compressed)
//   static raw .ply (+ --sog)   -> compress to .sog (rewrite url/name in the output manifest)
//   sog4d / .sog / .splat / …   -> copy the file as-is
const assets = []; // { kind:'dir'|'file', rel, convert?, sogRel?, url?, name? }
const seen = new Set();
for (const s of (manifest.sources || [])) {
    const url = s.url || '';
    if (/^https?:\/\//i.test(url)) { warnings.push(`cross-origin source kept as absolute URL (not bundled): ${url}`); continue; }
    if (seen.has(url)) continue; // dedupe (matches import: one .sog4d recreates all its sub-splats)
    seen.add(url);
    const rel = stripDot(url);
    if (s.kind === 'atlas') {
        assets.push({ kind: 'dir', rel });
    } else if (opts.sog && /\.ply$/i.test(rel)) {
        assets.push({ kind: 'file', rel, convert: true, sogRel: rel.replace(/\.ply$/i, '.sog'), url, name: s.name });
    } else {
        assets.push({ kind: 'file', rel });
    }
}

// ---- 3. output dir + copy the bundle by EXCLUSION ------------------------
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

// ---- 4. copy/compress ONLY the referenced assets, preserving relative path --
// Rewrite maps are populated ONLY on a successful conversion, then applied to the output manifest.
const urlRewrite = new Map();   // old source url -> new (.sog) url
const nameRewrite = new Map();  // old source/clip name -> new (.sog) name
const sogReport = [];           // { rel, plyBytes, sogBytes }
for (const a of assets) {
    const src = path.join(distDir, a.rel);
    if (a.kind === 'dir') {
        if (!copyDirSync(src, path.join(outDir, a.rel))) warnings.push(`referenced bake missing in dist (place it under public/${a.rel} and rebuild): ${a.rel}`);
        continue;
    }
    if (!fs.existsSync(src)) {
        warnings.push(`referenced asset missing in dist (place it under public/${a.rel} and rebuild): ${a.rel}`);
        continue;
    }
    if (a.convert) {
        const plyBytes = fs.statSync(src).size;
        const sogBytes = tryConvertSog(src, path.join(outDir, a.sogRel));
        if (sogBytes > 0) {
            urlRewrite.set(a.url, `./${a.sogRel}`);
            if (a.name) nameRewrite.set(a.name, a.name.replace(/\.ply$/i, '.sog'));
            sogReport.push({ rel: a.rel, plyBytes, sogBytes });
        } else {
            copyFileSync(src, path.join(outDir, a.rel)); // fallback: raw .ply, no manifest rewrite
        }
    } else {
        copyFileSync(src, path.join(outDir, a.rel));
    }
}

// ---- 5. write the manifest into the output root (with .ply -> .sog rewrites) --
const outManifest = JSON.parse(JSON.stringify(manifest));
for (const s of (outManifest.sources || [])) {
    if (s.url && urlRewrite.has(s.url)) s.url = urlRewrite.get(s.url);
    if (s.name && nameRewrite.has(s.name)) s.name = nameRewrite.get(s.name);
}
for (const c of (outManifest.clips || [])) {
    if (c.sourceName && nameRewrite.has(c.sourceName)) c.sourceName = nameRewrite.get(c.sourceName);
}
fs.writeFileSync(path.join(outDir, opts.manifestName), JSON.stringify(outManifest, null, 2));

// ---- 6. rewrite index.html: auto-open the scene in player mode + strip eruda --
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

// ---- 7. summary ----------------------------------------------------------
const mb = (bytesCopied / (1024 * 1024)).toFixed(1);
console.log(`\n📦 Packaged scene → ${outDir}`);
console.log(`   ${filesCopied} files, ${mb} MB`);
console.log(`   assets: ${assets.map(a => (a.convert && urlRewrite.has(a.url)) ? `${a.sogRel} (from .ply)` : a.rel).join(', ') || '(none)'}`);
if (sogReport.length) {
    console.log(`\n🗜️  SOG-compressed ${sogReport.length} static source(s):`);
    for (const r of sogReport) {
        const ratio = (r.plyBytes / r.sogBytes).toFixed(1);
        console.log(`   - ${r.rel}: ${(r.plyBytes / 1e6).toFixed(1)} MB → ${(r.sogBytes / 1e6).toFixed(2)} MB (.sog, ${ratio}× smaller)`);
    }
} else if (opts.sog) {
    console.log(`   (no raw .ply static sources to SOG-compress)`);
}
if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s):`);
    warnings.forEach(w => console.log(`   - ${w}`));
}
console.log(`\n✨ Serve it:  npx serve "${path.relative(repoRoot, outDir)}" -C   (opens the scene in player mode)`);

#!/usr/bin/env node

/**
 * Generate pre-parsed dictionary files from traditional .aff/.dic files
 * 
 * Usage: node generate-preparsed-dict.js <language> <input-path> <output-path>
 * Example: node generate-preparsed-dict.js it_IT ./dictionaries ./preparsed-dicts
 * 
 * Requires: npm install re2
 */

const fs = require('fs');
const path = require('path');
const Typo = require('./typo.js');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
    console.error('Usage: node generate-preparsed-dict.js <language> <input-path> <output-path>');
    console.error('Example: node generate-preparsed-dict.js it_IT ./dictionaries ./preparsed-dicts');
    process.exit(1);
}

const language = args[0];
const inputPath = args[1];
const outputPath = args[2];

// Load re2 for backtrack-proof regex matching
let RE2;
try {
    RE2 = require('re2');
    console.log('✓ Loaded re2 for backtrack-proof regex matching');
} catch (e) {
    console.warn('⚠ re2 not found (npm install re2)');
    console.warn('  Falling back to native regex — some dictionaries may freeze on');
    console.warn('  pathological patterns. The expansion and depth limits will still apply.');
    RE2 = null;
}
console.log('');

console.log('='.repeat(70));
console.log('Generating Pre-Parsed Dictionary');
console.log('='.repeat(70));
console.log('Language:', language);
console.log('Input path:', inputPath);
console.log('Output path:', outputPath);
console.log('');

// Load traditional dictionary
console.log('Step 1: Loading traditional dictionary files...');
const affPath = path.join(inputPath, language, language + '.aff');
const dicPath = path.join(inputPath, language, language + '.dic');

if (!fs.existsSync(affPath)) {
    console.error('Error: .aff file not found:', affPath);
    process.exit(1);
}

if (!fs.existsSync(dicPath)) {
    console.error('Error: .dic file not found:', dicPath);
    process.exit(1);
}

const affData = fs.readFileSync(affPath, 'utf8');
let dicData = fs.readFileSync(dicPath, 'utf8');

console.log('  ✓ Loaded .aff file:', affPath);
console.log('  ✓ Loaded .dic file:', dicPath);

// Clean .dic file if it has comment lines (like Italian dictionary)
const dicLines = dicData.split('\n');
if (dicLines.length > 1 && dicLines[1].trim().startsWith('/')) {
    console.log('  ⚠ Detected comment lines in .dic file - removing them...');
    const originalLineCount = dicLines.length;
    
    const cleanedLines = dicLines.filter((line, index) => {
        if (index === 0) return true;  // Keep word count line
        const trimmed = line.trim();
        return !trimmed.startsWith('/') && trimmed !== '';
    });
    
    // Update word count
    const actualWordCount = cleanedLines.length - 1;
    cleanedLines[0] = actualWordCount.toString();
    
    console.log('  ✓ Removed', originalLineCount - cleanedLines.length, 'comment/empty lines');
    dicData = cleanedLines.join('\n');
}
console.log('');

// Build Typo constructor settings
var typoSettings = {
    loadingCallback: function(phase, current, total) {
        if (phase === 'aff') {
            if (current === 0) {
                process.stdout.write('  Parsing affix rules...');
            } else {
                process.stdout.write(' done\n');
            }
        } else if (phase === 'dic') {
            if (total > 0) {
                const percent = Math.round((current / total) * 100);
                process.stdout.write('\r  Expanding dictionary: ' + percent + '% (' + current.toLocaleString() + '/' + total.toLocaleString() + ' entries)');
                if (current === total) {
                    process.stdout.write('\n');
                }
            }
        }
    }
};

// Use re2 for backtrack-proof regex matching if available.
// RE2 guarantees linear-time matching, eliminating catastrophic backtracking
// entirely at the engine level.  A cache converts each native RegExp to an
// RE2 instance on first encounter; subsequent calls are a simple Map lookup.
if (RE2) {
    var re2Cache = new Map();
    typoSettings.testRegex = function(regex, string) {
        var re2 = re2Cache.get(regex);
        if (!re2) {
            try {
                re2 = new RE2(regex.source, regex.flags);
            } catch (e) {
                // If RE2 can't handle the pattern, fall back to the native object
                re2 = regex;
            }
            re2Cache.set(regex, re2);
        }
        return re2.test(string);
    };
}

// Create Typo instance and load dictionary
console.log('Step 2: Parsing dictionary and expanding words...');
console.log('  (This may take several minutes for large dictionaries)');
const startTime = Date.now();

let dict;
try {
    dict = new Typo(language, affData, dicData, typoSettings);
} catch (error) {
    console.error('Error: Failed to parse dictionary');
    console.error('  ' + (error.message || error));
    process.exit(1);
}

const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('  ✓ Dictionary loaded and expanded in ' + loadTime + 's');
console.log('');

// Export pre-parsed data with progress reporting
console.log('Step 3: Exporting pre-parsed word lists...');

let lastPhase = '';
const exported = dict.exportPreParsed(function(progress) {
    if (progress.phase !== lastPhase) {
        if (lastPhase) process.stdout.write('\n');
        lastPhase = progress.phase;
    }
    
    if (progress.phase === 'collecting' || progress.phase === 'sorting') {
        const percent = progress.total > 1 
            ? Math.round((progress.current / progress.total) * 100) + '%'
            : '...';
        process.stdout.write(`\r  ${progress.phase}: ${percent}`);
    } else if (progress.phase === 'complete') {
        process.stdout.write('\r  ✓ Export complete\n');
    }
});

console.log('  ✓ Total words:', exported.dictionary.totalWords.toLocaleString());
console.log('  ✓ Unflagged words:', exported.dictionary.words.length.toLocaleString());
console.log('  ✓ Flagged words:', exported.dictionary.flaggedWordCount.toLocaleString());

// Display expansion diagnostics
if (exported.diagnostics) {
    const diag = exported.diagnostics;
    console.log('');
    console.log('-'.repeat(70));
    console.log('Expansion Diagnostics');
    console.log('-'.repeat(70));
    console.log('  Expansion limit hits:', diag.expansionLimitHits.toLocaleString());
    console.log('  Depth limit hits:', diag.depthLimitHits.toLocaleString());
    
    if (diag.expansionHistogram) {
        const h = diag.expansionHistogram;
        console.log('');
        console.log('  Expansion Distribution (' + h.totalWords.toLocaleString() + ' base words with rules):');
        console.log('    Min:', h.min, ' Max:', h.max, ' Mean:', h.mean, ' Median:', h.median);
        console.log('    P90:', h.percentiles.p90, ' P95:', h.percentiles.p95,
                     ' P99:', h.percentiles.p99, ' P99.9:', h.percentiles.p999);
        
        console.log('');
        console.log('  Bucket Distribution:');
        // Find max count for bar chart scaling
        let maxCount = 0;
        for (const b of h.buckets) { if (b.count > maxCount) maxCount = b.count; }
        const barWidth = 40;
        
        for (const b of h.buckets) {
            const pct = (b.count / h.totalWords * 100).toFixed(1);
            const bar = '█'.repeat(Math.max(1, Math.round(b.count / maxCount * barWidth)));
            const label = b.range.padStart(10);
            const countStr = b.count.toLocaleString().padStart(8);
            console.log('    ' + label + ': ' + countStr + ' (' + pct.padStart(5) + '%) ' + bar);
        }
        
        console.log('');
        console.log('  Top 20 Expansion Counts:');
        console.log('    ' + h.top20.join(', '));
        
        // Suggest a cutoff based on the data
        console.log('');
        console.log('  Cutoff Analysis (words retained if limit set to value):');
        const cutoffs = [50, 100, 150, 200, 250, 500, 1000];
        for (const c of cutoffs) {
            // Words that would be unaffected (count <= c)
            let retained = 0;
            for (const b of h.buckets) {
                // Parse the range to see if the bucket falls within the cutoff
                const parts = b.range.split('-');
                const upper = b.range.endsWith('+') ? Infinity : parseInt(parts[parts.length - 1]);
                if (upper <= c) {
                    retained += b.count;
                }
            }
            const retainedPct = (retained / h.totalWords * 100).toFixed(1);
            const clipped = h.totalWords - retained;
            console.log('    Limit ' + String(c).padStart(5) + ': ' +
                        retained.toLocaleString().padStart(8) + ' unaffected (' + retainedPct + '%), ' +
                        clipped.toLocaleString().padStart(6) + ' clipped');
        }
    }
}
console.log('');

// Create output directory structure
console.log('Step 4: Writing dictionary file to disk...');
const zlib = require('zlib');
const langOutputPath = path.join(outputPath, language);

fs.mkdirSync(langOutputPath, { recursive: true });

// Serialize the dictionary data (without diagnostics — those are for the console only)
const jsonString = JSON.stringify(exported.dictionary);
const jsonSize = Buffer.byteLength(jsonString, 'utf8');
console.log('  Uncompressed JSON size:', (jsonSize / 1024 / 1024).toFixed(2), 'MB');

// Gzip compress
const compressed = zlib.gzipSync(jsonString, { level: 9 });
const gzipSize = compressed.length;
const ratio = ((1 - gzipSize / jsonSize) * 100).toFixed(1);
console.log('  Compressed size:', (gzipSize / 1024 / 1024).toFixed(2), 'MB (' + ratio + '% reduction)');

// Write the single output file
const dictPath = path.join(langOutputPath, 'dictionary.json.gz');
fs.writeFileSync(dictPath, compressed);
console.log('  ✓ Written', dictPath);
console.log('');

// Generate summary
const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('='.repeat(70));
console.log('COMPLETE!');
console.log('='.repeat(70));
console.log('Output directory:', langOutputPath);
console.log('Output file:', dictPath);
console.log('Uncompressed size:', (jsonSize / 1024 / 1024).toFixed(2), 'MB');
console.log('Compressed size:', (gzipSize / 1024 / 1024).toFixed(2), 'MB');
console.log('Total processing time:', totalTime + 's');
console.log('');
console.log('Usage in Typo.js:');
console.log('  var dict = new Typo("' + language + '", null, null, {');
console.log('    preParsed: true,');
console.log('    preParsedPath: "' + outputPath + '",');
console.log('    asyncLoad: true,');
console.log('    loadedCallback: function(typo) { /* ready */ }');
console.log('  });');
console.log('');

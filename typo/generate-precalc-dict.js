#!/usr/bin/env node

/**
 * Generate pre-calculated dictionary files from traditional .aff/.dic files
 * 
 * Usage: node generate-precalc-dict.js <language> <input-path> <output-path>
 * Example: node generate-precalc-dict.js it_IT ./dictionaries ./precalc-dicts
 * 
 * Requires: npm install super-regex
 */

const fs = require('fs');
const path = require('path');
const Typo = require('./typo.js');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 3) {
    console.error('Usage: node generate-precalc-dict.js <language> <input-path> <output-path>');
    console.error('Example: node generate-precalc-dict.js it_IT ./dictionaries ./precalc-dicts');
    process.exit(1);
}

const language = args[0];
const inputPath = args[1];
const outputPath = args[2];

// Main async wrapper (needed because super-regex is ESM-only)
(async function() {

// Load super-regex for regex timeout protection
let superRegex;
try {
    superRegex = await import('super-regex');
    console.log('✓ Loaded super-regex for regex timeout protection');
} catch (e) {
    console.warn('⚠ super-regex not found (npm install super-regex)');
    console.warn('  Falling back to native regex — some dictionaries may freeze on');
    console.warn('  pathological patterns. The time-based safety limit will still apply.');
    superRegex = null;
}
console.log('');

console.log('='.repeat(70));
console.log('Generating Pre-Calculated Dictionary');
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

// Use super-regex for timeout-protected regex matching if available
if (superRegex) {
    typoSettings.testRegex = function(regex, string) {
        // super-regex returns false on both non-match and timeout.
        // A timed-out regex means a pathological pattern that wouldn't
        // produce useful results anyway, so treating it as non-match is fine.
        return superRegex.isMatch(regex, string, { timeout: 1000 });
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

// Export pre-calculated data with progress reporting
console.log('Step 3: Exporting pre-calculated word lists...');

let lastPhase = '';
const exported = dict.exportPreCalculated(function(progress) {
    if (progress.phase !== lastPhase) {
        if (lastPhase) process.stdout.write('\n');
        lastPhase = progress.phase;
    }
    
    if (progress.phase === 'bloom' || progress.phase === 'partitioning') {
        const percent = Math.round((progress.current / progress.total) * 100);
        process.stdout.write(`\r  ${progress.phase}: ${percent}%`);
    } else if (progress.phase === 'complete') {
        process.stdout.write('\r  ✓ Export complete\n');
    }
});

console.log('  ✓ Total words:', exported.index.totalWords.toLocaleString());
console.log('  ✓ Partitions:', exported.index.partitionCount);
console.log('  ✓ Bloom filter size:', exported.bloom.bits.length.toLocaleString(), 'bytes');
console.log('');

// Create output directory structure
console.log('Step 4: Writing files to disk...');
const langOutputPath = path.join(outputPath, language);
const wordsOutputPath = path.join(langOutputPath, 'words');

fs.mkdirSync(wordsOutputPath, { recursive: true });

// Write index file (pretty-printed for readability)
const indexPath = path.join(langOutputPath, 'index.json');
fs.writeFileSync(indexPath, JSON.stringify(exported.index, null, 2));
console.log('  ✓ Written index.json');

// Write bloom filter file (compact - it's large)
const bloomPath = path.join(langOutputPath, 'bloom.json');
fs.writeFileSync(bloomPath, JSON.stringify(exported.bloom));
const bloomSize = fs.statSync(bloomPath).size;
console.log('  ✓ Written bloom.json (' + (bloomSize / 1024).toFixed(1) + ' KB)');

// Write compound rules file (pretty-printed for readability)
const compoundPath = path.join(langOutputPath, 'compound.json');
fs.writeFileSync(compoundPath, JSON.stringify(exported.compound, null, 2));
console.log('  ✓ Written compound.json');

// Write rules dictionary file (compact - can be large)
const rulesPath = path.join(langOutputPath, 'rules.json');
fs.writeFileSync(rulesPath, JSON.stringify(exported.rules));
const rulesSize = fs.statSync(rulesPath).size;
console.log('  ✓ Written rules.json (' + (rulesSize / 1024).toFixed(1) + ' KB)');

// Write partition files (compact to save space)
let partitionCount = 0;
let totalBytes = 0;
for (const prefix in exported.partitions) {
    const partition = exported.partitions[prefix];
    const partitionPath = path.join(wordsOutputPath, prefix + '.json');
    const json = JSON.stringify(partition);  // Compact JSON
    fs.writeFileSync(partitionPath, json);
    partitionCount++;
    totalBytes += json.length;
    
    // Progress indicator for partition writing
    if (partitionCount % 50 === 0) {
        process.stdout.write(`\r  Writing partitions: ${partitionCount}...`);
    }
}
process.stdout.write(`\r  ✓ Written ${partitionCount} partition files\n`);
console.log('  ✓ Total partition size:', (totalBytes / 1024 / 1024).toFixed(2), 'MB');
console.log('');

// Calculate total output size
let totalSize = bloomSize + rulesSize + totalBytes;
totalSize += fs.statSync(indexPath).size;
totalSize += fs.statSync(compoundPath).size;

// Generate summary
const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('='.repeat(70));
console.log('COMPLETE!');
console.log('='.repeat(70));
console.log('Output directory:', langOutputPath);
console.log('Total output size:', (totalSize / 1024 / 1024).toFixed(2), 'MB');
console.log('Total processing time:', totalTime + 's');
console.log('');
console.log('Files generated:');
console.log('  - index.json       (partition index)');
console.log('  - bloom.json       (bloom filter)');
console.log('  - compound.json    (compound word rules)');
console.log('  - rules.json       (affix rules for hasFlag)');
console.log('  - words/*.json     (' + partitionCount + ' partition files)');
console.log('');
console.log('Usage in Typo.js:');
console.log('  var dict = new Typo("' + language + '", null, null, {');
console.log('    preCalculated: true,');
console.log('    preCalculatedPath: "' + outputPath + '"');
console.log('  });');
console.log('');

#!/usr/bin/env node

/**
 * Generate pre-calculated dictionary files from traditional .aff/.dic files
 * 
 * Usage: node generate-precalc-dict.js <language> <input-path> <output-path>
 * Example: node generate-precalc-dict.js it_IT ./dictionaries ./precalc-dicts
 */

const fs = require('fs');
const path = require('path');
const Typo = require('./typo-precalc.js');

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
const dicData = fs.readFileSync(dicPath, 'utf8');

console.log('  ✓ Loaded .aff file:', affPath);
console.log('  ✓ Loaded .dic file:', dicPath);
console.log('');

// Create Typo instance and load dictionary
console.log('Step 2: Parsing dictionary and expanding words...');
console.log('  (This may take several minutes for large dictionaries)');
const startTime = Date.now();

const dict = new Typo(language, affData, dicData);

const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('  ✓ Dictionary loaded and expanded in ' + loadTime + 's');
console.log('');

// Export pre-calculated data
console.log('Step 3: Exporting pre-calculated word lists...');
const exported = dict.exportPreCalculated();

console.log('  ✓ Total words:', exported.index.totalWords.toLocaleString());
console.log('  ✓ Partitions:', exported.index.partitionCount);
console.log('  ✓ Bloom filter size:', (exported.bloom.bits.length).toLocaleString(), 'bytes');
console.log('');

// Create output directory structure
console.log('Step 4: Writing files to disk...');
const langOutputPath = path.join(outputPath, language);
const wordsOutputPath = path.join(langOutputPath, 'words');

if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
}

if (!fs.existsSync(langOutputPath)) {
    fs.mkdirSync(langOutputPath, { recursive: true });
}

if (!fs.existsSync(wordsOutputPath)) {
    fs.mkdirSync(wordsOutputPath, { recursive: true });
}

// Write index file
const indexPath = path.join(langOutputPath, 'index.json');
fs.writeFileSync(indexPath, JSON.stringify(exported.index, null, 2));
console.log('  ✓ Written index.json');

// Write bloom filter file
const bloomPath = path.join(langOutputPath, 'bloom.json');
fs.writeFileSync(bloomPath, JSON.stringify(exported.bloom, null, 2));
console.log('  ✓ Written bloom.json');

// Write compound rules file
const compoundPath = path.join(langOutputPath, 'compound.json');
fs.writeFileSync(compoundPath, JSON.stringify(exported.compound, null, 2));
console.log('  ✓ Written compound.json');

// Write partition files
let partitionCount = 0;
let totalBytes = 0;
for (const prefix in exported.partitions) {
    const partition = exported.partitions[prefix];
    const partitionPath = path.join(langOutputPath, partition.file);
    const json = JSON.stringify(partition, null, 2);
    fs.writeFileSync(partitionPath, json);
    partitionCount++;
    totalBytes += json.length;
}
console.log('  ✓ Written ' + partitionCount + ' partition files');
console.log('  ✓ Total size:', (totalBytes / 1024 / 1024).toFixed(2), 'MB');
console.log('');

// Generate summary
const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('='.repeat(70));
console.log('COMPLETE!');
console.log('='.repeat(70));
console.log('Output directory:', langOutputPath);
console.log('Total processing time:', totalTime + 's');
console.log('');
console.log('Files generated:');
console.log('  - index.json       (partition index)');
console.log('  - bloom.json       (bloom filter)');
console.log('  - compound.json    (compound word rules)');
console.log('  - words/*.json     (' + partitionCount + ' partition files)');
console.log('');
console.log('Usage in Typo.js:');
console.log('  var dict = new Typo("' + language + '", null, null, {');
console.log('    preCalculated: true,');
console.log('    preCalculatedPath: "' + outputPath + '"');
console.log('  });');
console.log('');

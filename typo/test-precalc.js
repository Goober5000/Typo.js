#!/usr/bin/env node

/**
 * Test script for pre-calculated dictionary system
 * 
 * Usage: node test-precalc.js <language> <precalc-path>
 * Example: node test-precalc.js it_IT ./precalc-dicts
 */

const Typo = require('./typo-precalc.js');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: node test-precalc.js <language> <precalc-path>');
    console.error('Example: node test-precalc.js it_IT ./precalc-dicts');
    process.exit(1);
}

const language = args[0];
const precalcPath = args[1];

console.log('='.repeat(70));
console.log('Testing Pre-Calculated Dictionary');
console.log('='.repeat(70));
console.log('Language:', language);
console.log('Pre-calculated path:', precalcPath);
console.log('');

// Load dictionary
console.log('Loading dictionary...');
const startTime = Date.now();

const dict = new Typo(language, null, null, {
    preCalculated: true,
    preCalculatedPath: precalcPath
});

const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('✓ Dictionary loaded in ' + loadTime + 's');
console.log('');

// Test cases for Italian
const testWords = {
    'it_IT': {
        correct: ['ciao', 'buongiorno', 'grazie', 'prego', 'arrivederci', 'casa', 'libro', 'amico'],
        incorrect: ['ciaooo', 'gratzie', 'arrivedrci', 'kasa', 'libri', 'amicoo']
    },
    'en_US': {
        correct: ['hello', 'world', 'dictionary', 'test', 'word', 'check', 'spell', 'correct'],
        incorrect: ['helo', 'wrld', 'dictionery', 'tset', 'wrod', 'chek', 'spel', 'corect']
    },
    'de_DE': {
        correct: ['hallo', 'welt', 'wörterbuch', 'test', 'wort', 'prüfen', 'rechtschreibung'],
        incorrect: ['halo', 'velt', 'werterbuch', 'tset', 'vort', 'prufen', 'rechtschribung']
    }
};

const tests = testWords[language] || testWords['en_US'];

// Test correct words
console.log('Testing CORRECT words:');
console.log('-'.repeat(70));
let correctCount = 0;
const checkStart = Date.now();

for (const word of tests.correct) {
    const result = dict.check(word);
    const status = result ? '✓' : '✗';
    console.log('  ' + status + ' "' + word + '" → ' + result);
    if (result) correctCount++;
}

const checkTime = Date.now() - checkStart;
console.log('');
console.log('Result: ' + correctCount + '/' + tests.correct.length + ' correct');
console.log('Time: ' + checkTime + 'ms (' + (checkTime / tests.correct.length).toFixed(1) + 'ms per word)');
console.log('');

// Test incorrect words
console.log('Testing INCORRECT words (should all be false):');
console.log('-'.repeat(70));
let incorrectCount = 0;
const incorrectStart = Date.now();

for (const word of tests.incorrect) {
    const result = dict.check(word);
    const status = !result ? '✓' : '✗';
    console.log('  ' + status + ' "' + word + '" → ' + result);
    if (!result) incorrectCount++;
}

const incorrectTime = Date.now() - incorrectStart;
console.log('');
console.log('Result: ' + incorrectCount + '/' + tests.incorrect.length + ' correctly rejected');
console.log('Time: ' + incorrectTime + 'ms (' + (incorrectTime / tests.incorrect.length).toFixed(1) + 'ms per word)');
console.log('');

// Cache statistics
console.log('Cache Statistics:');
console.log('-'.repeat(70));
console.log('Partition cache size:', dict.partitionCache.keys.length);
console.log('Not-found cache size:', dict.notFoundCache.size);
console.log('');

// Summary
const totalTests = tests.correct.length + tests.incorrect.length;
const totalCorrect = correctCount + incorrectCount;
const accuracy = ((totalCorrect / totalTests) * 100).toFixed(1);

console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log('Total tests:', totalTests);
console.log('Correct results:', totalCorrect);
console.log('Accuracy:', accuracy + '%');
console.log('Average lookup time:', ((checkTime + incorrectTime) / totalTests).toFixed(1) + 'ms');
console.log('');

if (totalCorrect === totalTests) {
    console.log('✓ ALL TESTS PASSED!');
} else {
    console.log('✗ SOME TESTS FAILED');
    process.exit(1);
}

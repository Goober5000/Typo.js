#!/usr/bin/env node

/**
 * Test script for pre-calculated dictionary system
 * 
 * Usage: node test-precalc.js <language> <precalc-path>
 * Example: node test-precalc.js it_IT ./precalc-dicts
 */

const Typo = require('./typo.js');

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

let dict;
try {
    dict = new Typo(language, null, null, {
        preCalculated: true,
        preCalculatedPath: precalcPath
    });
} catch (error) {
    console.error('✗ Failed to load pre-calculated dictionary.');
    console.error('  Ensure the pre-calculated files exist at: ' + precalcPath + '/' + language + '/');
    console.error('  Error:', error.message || error);
    process.exit(1);
}

const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
console.log('✓ Dictionary loaded in ' + loadTime + 's');
console.log('');

// Test data per language
const testWords = {
    'it_IT': {
        correct: ['ciao', 'buongiorno', 'grazie', 'prego', 'arrivederci', 'casa', 'libro', 'amico', 'libri'],
        incorrect: ['ciaooo', 'gratzie', 'arrivedrci', 'kasa', 'amicoo', 'buongiornoo'],
        suggest: [
            { misspelling: 'gratzie', expectContains: 'grazie' },
            { misspelling: 'kasa', expectContains: 'casa' }
        ],
        hasFlag: [
            // Test that a normal word does NOT have KEEPCASE
            { word: 'casa', flag: 'KEEPCASE', expected: false }
        ]
    },
    'en_US': {
        correct: ['hello', 'world', 'dictionary', 'test', 'word', 'check', 'spell', 'correct'],
        incorrect: ['helo', 'wrld', 'dictionery', 'tset', 'wrod', 'chek', 'spel', 'corect'],
        suggest: [
            { misspelling: 'spel', expectContains: 'spell' },
            { misspelling: 'corect', expectContains: 'correct' }
        ],
        hasFlag: [
            { word: 'hello', flag: 'KEEPCASE', expected: false }
        ]
    },
    'de_DE': {
        correct: ['hallo', 'welt', 'wörterbuch', 'test', 'wort', 'prüfen', 'rechtschreibung'],
        incorrect: ['halo', 'velt', 'werterbuch', 'tset', 'vort', 'prufen', 'rechtschribung'],
        suggest: [
            { misspelling: 'werterbuch', expectContains: 'wörterbuch' }
        ],
        hasFlag: [
            { word: 'hallo', flag: 'KEEPCASE', expected: false }
        ]
    }
};

const tests = testWords[language] || testWords['en_US'];
let totalTests = 0;
let totalPassed = 0;

// =====================================================================
// Test 1: Correct words (check should return true)
// =====================================================================
console.log('Test 1: CORRECT words (expecting true):');
console.log('-'.repeat(70));
let correctCount = 0;
const checkStart = Date.now();

for (const word of tests.correct) {
    const result = dict.check(word);
    const passed = result === true;
    const status = passed ? '✓' : '✗';
    console.log('  ' + status + ' check("' + word + '") → ' + result);
    if (passed) correctCount++;
    totalTests++;
}

const checkTime = Date.now() - checkStart;
totalPassed += correctCount;
console.log('');
console.log('Result: ' + correctCount + '/' + tests.correct.length + ' passed');
console.log('Time: ' + checkTime + 'ms (' + (checkTime / tests.correct.length).toFixed(1) + 'ms per word)');
console.log('');

// =====================================================================
// Test 2: Incorrect words (check should return false)
// =====================================================================
console.log('Test 2: INCORRECT words (expecting false):');
console.log('-'.repeat(70));
let incorrectCount = 0;
const incorrectStart = Date.now();

for (const word of tests.incorrect) {
    const result = dict.check(word);
    const passed = result === false;
    const status = passed ? '✓' : '✗';
    console.log('  ' + status + ' check("' + word + '") → ' + result);
    if (passed) incorrectCount++;
    totalTests++;
}

const incorrectTime = Date.now() - incorrectStart;
totalPassed += incorrectCount;
console.log('');
console.log('Result: ' + incorrectCount + '/' + tests.incorrect.length + ' passed');
console.log('Time: ' + incorrectTime + 'ms (' + (incorrectTime / tests.incorrect.length).toFixed(1) + 'ms per word)');
console.log('');

// =====================================================================
// Test 3: Suggestions (suggest should return plausible corrections)
// =====================================================================
if (tests.suggest && tests.suggest.length > 0) {
    console.log('Test 3: SUGGESTIONS:');
    console.log('-'.repeat(70));
    let suggestCount = 0;

    for (const testCase of tests.suggest) {
        const suggestions = dict.suggest(testCase.misspelling, 5);
        const found = suggestions.indexOf(testCase.expectContains) !== -1;
        const status = found ? '✓' : '✗';
        console.log('  ' + status + ' suggest("' + testCase.misspelling + '") → [' + suggestions.join(', ') + ']');
        if (!found) {
            console.log('      Expected "' + testCase.expectContains + '" in suggestions');
        }
        if (found) suggestCount++;
        totalTests++;
    }

    totalPassed += suggestCount;
    console.log('');
    console.log('Result: ' + suggestCount + '/' + tests.suggest.length + ' passed');
    console.log('');
}

// =====================================================================
// Test 4: hasFlag (verify flag lookups work in precalculated mode)
// =====================================================================
if (tests.hasFlag && tests.hasFlag.length > 0) {
    console.log('Test 4: hasFlag:');
    console.log('-'.repeat(70));
    let flagCount = 0;

    for (const testCase of tests.hasFlag) {
        const result = dict.hasFlag(testCase.word, testCase.flag);
        const passed = result === testCase.expected;
        const status = passed ? '✓' : '✗';
        console.log('  ' + status + ' hasFlag("' + testCase.word + '", "' + testCase.flag + '") → ' + result + ' (expected ' + testCase.expected + ')');
        if (passed) flagCount++;
        totalTests++;
    }

    totalPassed += flagCount;
    console.log('');
    console.log('Result: ' + flagCount + '/' + tests.hasFlag.length + ' passed');
    console.log('');
}

// =====================================================================
// Cache statistics
// =====================================================================
console.log('Cache Statistics:');
console.log('-'.repeat(70));
console.log('Partition cache entries:', dict.partitionCache.cache.size);
console.log('Not-found cache entries:', dict.notFoundCache.cache.size);
console.log('');

// =====================================================================
// Summary
// =====================================================================
const accuracy = ((totalPassed / totalTests) * 100).toFixed(1);

console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log('Total tests:', totalTests);
console.log('Passed:', totalPassed);
console.log('Failed:', totalTests - totalPassed);
console.log('Accuracy:', accuracy + '%');
console.log('Average check time:', ((checkTime + incorrectTime) / (tests.correct.length + tests.incorrect.length)).toFixed(1) + 'ms');
console.log('');

if (totalPassed === totalTests) {
    console.log('✓ ALL TESTS PASSED!');
} else {
    console.log('✗ SOME TESTS FAILED');
    process.exit(1);
}

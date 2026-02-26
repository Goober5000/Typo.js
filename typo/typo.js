/* globals chrome: false */
/* globals __dirname: false */
/* globals require: false */
/* globals Buffer: false */
/* globals module: false */
/**
 * Typo is a JavaScript implementation of a spellchecker using hunspell-style
 * dictionaries.
 * 
 * ENHANCED VERSION: Supports both traditional .aff/.dic loading and pre-parsed
 * dictionaries (a single gzipped JSON file containing the fully expanded word list).
 */
var Typo;
(function () {
    "use strict";
    
    /**
     * Version of the pre-parsed dictionary format.
     * Increment this when making breaking changes to the format.
     */
    var PREPARSED_FORMAT_VERSION = 2;
    
    /**
     * Compare two strings using Unicode code point order.
     * This ensures consistent ordering across all JavaScript engines,
     * regardless of system locale settings.
     * 
     * @param {string} a First string
     * @param {string} b Second string
     * @returns {number} -1 if a < b, 1 if a > b, 0 if equal
     */
    function compareStrings(a, b) {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    }
    
    /**
     * Typo constructor.
     *
     * @param {string} [dictionary] The locale code of the dictionary being used. e.g.,
     *                              "en_US". This is only used to auto-load dictionaries.
     * @param {string} [affData]    The data from the dictionary's .aff file. If omitted
     *                              and Typo.js is being used in a Chrome extension, the .aff
     *                              file will be loaded automatically from
     *                              lib/typo/dictionaries/[dictionary]/[dictionary].aff
     *                              In other environments, it will be loaded from
     *                              [settings.dictionaryPath]/dictionaries/[dictionary]/[dictionary].dic
     * @param {string} [wordsData]  The data from the dictionary's .dic file. If omitted
     *                              and Typo.js is being used in a Chrome extension, the .dic
     *                              file will be loaded automatically from
     *                              lib/typo/dictionaries/[dictionary]/[dictionary].dic
     *                              In other environments, it will be loaded from
     *                              [settings.dictionaryPath]/dictionaries/[dictionary]/[dictionary].dic
     * @param {Object} [settings]   Constructor settings. Available properties are:
     *                              {string} [dictionaryPath]: path to load dictionary from in non-chrome
     *                              environment.
     *                              {Object} [flags]: flag information.
     *                              {boolean} [asyncLoad]: If true, affData and wordsData will be loaded
     *                              asynchronously.
     *                              {Function} [loadedCallback]: Called when both affData and wordsData
     *                              have been loaded. Only used if asyncLoad is set to true. The parameter
     *                              is the instantiated Typo object.
     *                              {boolean} [preParsed]: If true, load from pre-parsed word lists
     *                              instead of .aff/.dic files. Requires preParsedPath.
     *                              {string} [preParsedPath]: Path to pre-parsed dictionary files.
     *                              {Function} [loadingCallback]: Optional callback for reporting progress
     *                              during traditional dictionary loading. Called with
     *                              (phase, current, total) where phase is 'aff' or 'dic'.
     *                              {Function} [testRegex]: Optional function(regex, string) returning boolean.
     *                              Replaces the default regex test in affix rule matching.
     *                              Can be used to substitute an alternative regex engine such as RE2.
     *
     * @returns {Typo} A Typo object.
     */
    Typo = function (dictionary, affData, wordsData, settings) {
        settings = settings || {};
        this.dictionary = null;
        this.rules = {};
        this.dictionaryTable = new Map();
        this.compoundRules = [];
        this.compoundRuleCodes = {};
        this.replacementTable = [];
        this.flags = settings.flags || {};
        this.memoized = {};
        this.loaded = false;
        this.loadingCallback = settings.loadingCallback || null;
        this._testRegex = settings.testRegex || function(regex, string) {
            return regex.test(string);
        };
        
        // Pre-parsed dictionary support
        this.preParsed = settings.preParsed || false;
        this.preParsedPath = settings.preParsedPath || null;
        
        var self = this;
        var path;
        // Loop-control variables.
        var i, j, _len, _jlen;
        if (dictionary) {
            self.dictionary = dictionary;
            
            // PRE-PARSED MODE: Load from pre-parsed files
            if (self.preParsed && self.preParsedPath) {
                if (settings.asyncLoad) {
                    self._loadPreParsedAsync(function() {
                        if (settings.loadedCallback) {
                            settings.loadedCallback(self);
                        }
                    });
                } else {
                    self._loadPreParsed();
                }
                return this;
            }
            
            // TRADITIONAL MODE: Load from .aff/.dic files
            // If the data is preloaded, just setup the Typo object.
            if (affData && wordsData) {
                setup();
            }
            // Loading data for browser extensions.
            else if (typeof window !== 'undefined' && ((window.chrome && window.chrome.runtime) || (window.browser && window.browser.runtime))) {
                var runtime = window.chrome && window.chrome.runtime ? window.chrome.runtime : window.browser.runtime;
                path = "typo/dictionaries/" + dictionary + "/" + dictionary;
                if (!affData)
                    affData = self._readFile(runtime.getURL(path + ".aff"));
                if (!wordsData)
                    wordsData = self._readFile(runtime.getURL(path + ".dic"));
                setup();
            }
            else if (typeof require !== 'undefined') {
                // Node.js
                path = settings.dictionaryPath || '';
                if (!affData)
                    affData = self._readFile(path + "/" + dictionary + "/" + dictionary + ".aff", null, settings.asyncLoad);
                if (!wordsData)
                    wordsData = self._readFile(path + "/" + dictionary + "/" + dictionary + ".dic", null, settings.asyncLoad);
                if (settings.asyncLoad) {
                    Promise.all([affData, wordsData]).then(function (results) {
                        setup(results[0], results[1]);
                    });
                }
                else {
                    setup(affData, wordsData);
                }
            }
        }
        function setup(aff, words) {
            affData = aff || affData;
            wordsData = words || wordsData;
            self.rules = self._parseAFF(affData);
            // Save the rule codes that are used in compound rules.
            self.compoundRuleCodes = {};
            for (i = 0, _len = self.compoundRules.length; i < _len; i++) {
                var rule = self.compoundRules[i];
                for (j = 0, _jlen = rule.length; j < _jlen; j++) {
                    self.compoundRuleCodes[rule[j]] = [];
                }
            }
            // If we add this AFTER the general matching rule, we can access it from the match key.
            if ("COMPOUNDRULE" in self.flags) {
                self.compoundRuleCodes[self.flags.COMPOUNDRULE] = [];
            }
            // Now do the dictionary parsing (this is the part that is slow)
            self.dictionaryTable = self._parseDIC(wordsData);
            // Get rid of any codes from the compound rule codes that are never used
            // (or that were special regex characters).
            for (i in self.compoundRuleCodes) {
                if (self.compoundRuleCodes[i].length === 0) {
                    delete self.compoundRuleCodes[i];
                }
            }
            // Build the full regular expressions for each compound rule.
            // I have a feeling (but no confirmation yet) that this method of
            // testing for compound words is probably slow.
            for (i = 0, _len = self.compoundRules.length; i < _len; i++) {
                var ruleText = self.compoundRules[i];
                var expressionText = "";
                for (j = 0, _jlen = ruleText.length; j < _jlen; j++) {
                    var character = ruleText[j];
                    if (character in self.compoundRuleCodes) {
                        expressionText += "(" + self.compoundRuleCodes[character].join("|") + ")";
                    }
                    else {
                        expressionText += character;
                    }
                }
                self.compoundRules[i] = new RegExp('^' + expressionText + '$', "i");
            }
            self.loaded = true;
            if ((settings === null || settings === void 0 ? void 0 : settings.asyncLoad) && (settings === null || settings === void 0 ? void 0 : settings.loadedCallback)) {
                settings.loadedCallback(self);
            }
        }
        return this;
    };
    Typo.prototype = {
        /**
         * Loads a Typo instance from a hash of all of the Typo properties.
         *
         * @param {object} obj A hash of Typo properties, probably gotten from a JSON.parse(JSON.stringify(typo_instance)).
         */
        load: function (obj) {
            for (var i in obj) {
                if (obj.hasOwnProperty(i)) {
                    this[i] = obj[i];
                }
            }
            return this;
        },
        /**
         * Read the contents of a file.
         *
         * @param {string} path The path (relative) to the file.
         * @param {string} [charset="UTF-8"] The expected charset of the file
         * @param {boolean} async If true, the file will be read asynchronously. For node.js this does nothing, all
         *        files are read synchronously.
         * @returns {string} The file data if async is false, otherwise a promise object. If running node.js, the data is
         *          always returned.
         */
        _readFile: function (path, charset, async) {
            var _a;
            charset = charset || "utf8";
            if (typeof XMLHttpRequest !== 'undefined') {
                var req_1 = new XMLHttpRequest();
                req_1.open("GET", path, !!async);
                (_a = req_1.overrideMimeType) === null || _a === void 0 ? void 0 : _a.call(req_1, "text/plain; charset=" + charset);
                if (!!async) {
                    var promise = new Promise(function (resolve, reject) {
                        req_1.onload = function () {
                            if (req_1.status === 200) {
                                resolve(req_1.responseText);
                            }
                            else {
                                reject(req_1.statusText);
                            }
                        };
                        req_1.onerror = function () {
                            reject(req_1.statusText);
                        };
                    });
                    req_1.send(null);
                    return promise;
                }
                else {
                    req_1.send(null);
                    return req_1.responseText;
                }
            }
            else if (typeof require !== 'undefined') {
                // Node.js
                var fs = require("fs");
                try {
                    if (fs.existsSync(path)) {
                        return fs.readFileSync(path, charset);
                    }
                    else {
                        console.log("Path " + path + " does not exist.");
                    }
                }
                catch (e) {
                    console.log(e);
                }
                return '';
            }
            return '';
        },
        /**
         * Parse the rules out from a .aff file.
         *
         * @param {string} data The contents of the affix file.
         * @returns object The rules from the file.
         */
        _parseAFF: function (data) {
            var rules = {};
            var line, subline, numEntries, lineParts;
            var i, j, _len, _jlen;
            var lines = data.split(/\r?\n/);
            
            if (this.loadingCallback) {
                this.loadingCallback('aff', 0, lines.length);
            }
            
            for (i = 0, _len = lines.length; i < _len; i++) {
                // Remove comment lines
                line = this._removeAffixComments(lines[i]);
                line = line.trim();
                if (!line) {
                    continue;
                }
                var definitionParts = line.split(/\s+/);
                var ruleType = definitionParts[0];
                if (ruleType === "PFX" || ruleType === "SFX") {
                    var ruleCode = definitionParts[1];
                    var combineable = definitionParts[2];
                    numEntries = parseInt(definitionParts[3], 10);
                    var entries = [];
                    for (j = i + 1, _jlen = i + 1 + numEntries; j < _jlen; j++) {
                        subline = lines[j];
                        lineParts = subline.split(/\s+/);
                        var charactersToRemove = lineParts[2];
                        var additionParts = lineParts[3].split("/");
                        var charactersToAdd = additionParts[0];
                        if (charactersToAdd === "0")
                            charactersToAdd = "";
                        var continuationClasses = this.parseRuleCodes(additionParts[1]);
                        var regexToMatch = lineParts[4];
                        var entry = {
                            add: charactersToAdd
                        };
                        if (continuationClasses.length > 0)
                            entry.continuationClasses = continuationClasses;
                        if (regexToMatch !== ".") {
                            if (ruleType === "SFX") {
                                entry.match = new RegExp(regexToMatch + "$");
                            }
                            else {
                                entry.match = new RegExp("^" + regexToMatch);
                            }
                        }
                        if (charactersToRemove != "0") {
                            if (ruleType === "SFX") {
                                entry.remove = new RegExp(charactersToRemove + "$");
                            }
                            else {
                                entry.remove = charactersToRemove;
                            }
                        }
                        entries.push(entry);
                    }
                    rules[ruleCode] = { "type": ruleType, "combineable": (combineable === "Y"), "entries": entries };
                    i += numEntries;
                }
                else if (ruleType === "COMPOUNDRULE") {
                    numEntries = parseInt(definitionParts[1], 10);
                    for (j = i + 1, _jlen = i + 1 + numEntries; j < _jlen; j++) {
                        line = lines[j];
                        lineParts = line.split(/\s+/);
                        this.compoundRules.push(lineParts[1]);
                    }
                    i += numEntries;
                }
                else if (ruleType === "REP") {
                    lineParts = line.split(/\s+/);
                    if (lineParts.length === 3) {
                        this.replacementTable.push([lineParts[1], lineParts[2]]);
                    }
                }
                else {
                    // ONLYINCOMPOUND
                    // COMPOUNDMIN
                    // FLAG
                    // KEEPCASE
                    // NEEDAFFIX
                    this.flags[ruleType] = definitionParts[1];
                }
            }
            
            if (this.loadingCallback) {
                this.loadingCallback('aff', lines.length, lines.length);
            }
            
            return rules;
        },
        /**
         * Removes comments.
         *
         * @param {string} data A line from an affix file.
         * @return {string} The cleaned-up line.
         */
        _removeAffixComments: function (line) {
            // This used to remove any string starting with '#' up to the end of the line,
            // but some COMPOUNDRULE definitions include '#' as part of the rule.
            // So, only remove lines that begin with a comment, optionally preceded by whitespace.
            if (line.match(/^\s*#/)) {
                return '';
            }
            return line;
        },
        /**
         * Adds a word to the dictionary table with its associated rule codes.
         * Some dictionaries list the same word multiple times with different rule sets.
         * 
         * @param {Map} dictionaryTable The dictionary table to add to
         * @param {string} word The word to add
         * @param {Array} rules The rule codes associated with this word
         */
        _addWordToDictionary: function (dictionaryTable, word, rules) {
            if (rules.length > 0) {
                var existing = dictionaryTable.get(word);
                if (existing) {
                    // Word already has rule sets — append this set
                    existing.push(rules);
                } else {
                    // New word or word with no prior rules — start rule list
                    dictionaryTable.set(word, [rules]);
                }
            } else if (!dictionaryTable.has(word)) {
                // Word with no rules — null means "exists but no flags"
                dictionaryTable.set(word, null);
            }
        },

        /**
         * Tracks a word for compound word formation if it has compound rule codes.
         * 
         * @param {string} word The word to track
         * @param {string} ruleCode The rule code to check
         */
        _trackCompoundWord: function (word, ruleCode) {
            if (ruleCode in this.compoundRuleCodes) {
                this.compoundRuleCodes[ruleCode].push(word);
            }
        },

        /**
         * Applies combineable rules to a word that was already generated by another rule.
         * Only combines rules of different types (PFX + SFX or SFX + PFX).
         * 
         * @param {string} word The word to apply combinations to
         * @param {Object} baseRule The rule that generated this word
         * @param {number} baseRuleIndex Index of the base rule in the original rule codes array
         * @param {Array} allRuleCodes All rule codes from the original word
         * @param {Map} dictionaryTable The dictionary table to populate
         */
        _applyRuleCombinations: function (word, baseRule, baseRuleIndex, allRuleCodes, dictionaryTable) {
            var maxExpansions = this._maxExpansionsPerWord;
            // Try combining with subsequent rules in the list
            for (var i = baseRuleIndex + 1, len = allRuleCodes.length; i < len; i++) {
                if (this._expansionCount >= maxExpansions) {
                    break;
                }
                var combineCode = allRuleCodes[i];
                var combineRule = this.rules[combineCode];

                if (!combineRule) {
                    continue;
                }

                // Rules can only combine if:
                // 1. The combine rule is also combineable
                // 2. The rules are of different types (PFX vs SFX)
                if (combineRule.combineable && baseRule.type !== combineRule.type) {
                    var combinedWords = this._applyRule(word, combineRule);

                    // Add all combined forms to the dictionary
                    for (var j = 0, jlen = combinedWords.length; j < jlen; j++) {
                        this._addWordToDictionary(dictionaryTable, combinedWords[j], []);
                    }
                }
            }
        },

        /**
         * Applies a single affix rule to a word and adds all generated forms to the dictionary.
         * 
         * @param {string} word The base word
         * @param {string} ruleCode The rule code to apply
         * @param {number} ruleIndex The index of this rule in the word's rule codes array
         * @param {Array} allRuleCodes All rule codes for the original word (for combinations)
         * @param {Map} dictionaryTable The dictionary table to populate
         * @returns {Array} Array of newly generated words
         */
        _applySingleRuleToWord: function (word, ruleCode, ruleIndex, allRuleCodes, dictionaryTable) {
            var rule = this.rules[ruleCode];
            if (!rule) {
                return [];
            }

            // Apply the rule to generate new word forms
            var generatedWords = this._applyRule(word, rule);

            // Add each generated word to the dictionary
            var maxExpansions = this._maxExpansionsPerWord;
            for (var i = 0, len = generatedWords.length; i < len; i++) {
                if (this._expansionCount >= maxExpansions) {
                    break;
                }
                var newWord = generatedWords[i];
                this._addWordToDictionary(dictionaryTable, newWord, []);

                // If this rule can combine with others, apply combinations
                if (rule.combineable) {
                    this._applyRuleCombinations(newWord, rule, ruleIndex, allRuleCodes, dictionaryTable);
                }
            }

            return generatedWords;
        },

        /**
         * Maximum number of expanded word forms per base dictionary word.
         * Prevents combinatorial explosion when a word has many combineable
         * affix rules (the cross-product of PFX × SFX can be enormous).
         * V8's Map has a hard ceiling of 2^24 (~16.7M) entries, so without
         * this limit, large dictionaries like Italian can overflow it.
         */
        _maxExpansionsPerWord: 250,
        _expansionCount: 0,

        /**
         * Diagnostic counters: track how many base words hit the expansion
         * limit or the recursion depth limit during dictionary construction.
         * High values may indicate the limits are too restrictive.
         */
        _expansionLimitHits: 0,
        _depthLimitHits: 0,
        _depthLimitHit: false,
        _expansionHistogram: null,

        /**
         * Expands a word by applying all its affix rules and combinations.
         * This is the main entry point for affix expansion.
         * 
         * @param {string} word The base word from the dictionary
         * @param {Array} ruleCodesArray Array of rule codes to apply to this word
         * @param {Map} dictionaryTable The dictionary table to populate
         */
        _expandWordWithAffixes: function (word, ruleCodesArray, dictionaryTable) {
            // Reset per-word state
            this._expansionCount = 0;
            this._depthLimitHit = false;
            // First, check if this word should be added as-is (without NEEDAFFIX flag)
            var shouldAddBaseWord = true;
            if ("NEEDAFFIX" in this.flags) {
                if (ruleCodesArray.indexOf(this.flags.NEEDAFFIX) !== -1) {
                    shouldAddBaseWord = false;
                }
            }

            if (shouldAddBaseWord) {
                this._addWordToDictionary(dictionaryTable, word, ruleCodesArray);
            }

            // Apply each affix rule to the word
            for (var i = 0, len = ruleCodesArray.length; i < len; i++) {
                if (this._expansionCount >= this._maxExpansionsPerWord) {
                    break;
                }
                var ruleCode = ruleCodesArray[i];

                // Apply the rule and handle combinations
                this._applySingleRuleToWord(word, ruleCode, i, ruleCodesArray, dictionaryTable);

                // Track for compound word formation
                this._trackCompoundWord(word, ruleCode);
            }
            
            // Update diagnostic counters
            if (this._expansionHistogram) {
                this._expansionHistogram.push(this._expansionCount);
            }
            if (this._expansionCount >= this._maxExpansionsPerWord) {
                this._expansionLimitHits++;
            }
            if (this._depthLimitHit) {
                this._depthLimitHits++;
            }
        },

        /**
         * Summarizes the expansion histogram into percentiles, buckets,
         * and top-N outliers for diagnostic analysis.
         * @returns {Object|null} Summary object, or null if no histogram data
         */
        _summarizeHistogram: function () {
            var hist = this._expansionHistogram;
            if (!hist || hist.length === 0) return null;

            // Sort a copy for percentile calculations
            var sorted = hist.slice().sort(function (a, b) { return a - b; });
            var n = sorted.length;

            var sum = 0;
            for (var i = 0; i < n; i++) sum += sorted[i];

            // Percentile helper (nearest-rank method)
            function pct(p) { return sorted[Math.min(Math.ceil(p / 100 * n) - 1, n - 1)]; }

            // Build logarithmic buckets: 0, 1, 2-5, 6-10, 11-25, 26-50,
            // 51-100, 101-250, 251-500, 501-1000, 1001-2500, 2501+
            var bucketEdges = [0, 1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];
            var buckets = [];
            var bi = 0;
            for (var si = 0; si < n; si++) {
                while (bi < bucketEdges.length && sorted[si] > bucketEdges[bi]) bi++;
                var label = bi === 0 ? '0'
                    : bi < bucketEdges.length ? (bucketEdges[bi - 1] + 1) + '-' + bucketEdges[bi]
                    : (bucketEdges[bucketEdges.length - 1] + 1) + '+';
                if (buckets.length === 0 || buckets[buckets.length - 1].range !== label) {
                    buckets.push({ range: label, count: 1 });
                } else {
                    buckets[buckets.length - 1].count++;
                }
            }

            // Top 20 outliers (highest expansion counts)
            var topN = Math.min(20, n);
            var outliers = sorted.slice(n - topN).reverse();

            return {
                totalWords: n,
                min: sorted[0],
                max: sorted[n - 1],
                mean: Math.round(sum / n * 100) / 100,
                median: pct(50),
                percentiles: {
                    p90: pct(90),
                    p95: pct(95),
                    p99: pct(99),
                    p999: pct(99.9)
                },
                buckets: buckets,
                top20: outliers
            };
        },

        /**
         * Parses the dictionary file and builds the in-memory dictionary table.
         * Each word is expanded by applying its affix rules to generate all valid forms.
         * 
         * @param {string} data The contents of a .dic file
         * @returns {Map} The populated dictionary table
         */
        _parseDIC: function (data) {
            data = this._removeDicComments(data);
            var lines = data.split(/\r?\n/);
            var dictionaryTable = new Map();
            
            // Initialize per-word expansion histogram for diagnostics
            this._expansionHistogram = [];
            
            // Total entries (line 0 is the word count header)
            var totalEntries = lines.length - 1;
            
            if (this.loadingCallback) {
                this.loadingCallback('dic', 0, totalEntries);
            }

            // The first line is the number of words in the dictionary.
            // We skip it and start at line 1.
            for (var i = 1, len = lines.length; i < len; i++) {
                var line = lines[i];
                
                if (!line) {
                    // Ignore empty lines.
                    continue;
                }

                // Parse the line format:
                //     word
                //     word/flags
                //     word/flags xx:abc yy:def
                //     word xx:abc yy:def
                // 
                // We don't use the morphological flags (xx:abc, yy:def) and we don't want
                // them included in the extracted flags.
                var just_word_and_flags = line.replace(/\s.*$/, '');
                
                // just_word_and_flags is now one of:
                //     word
                //     word/flags
                var parts = just_word_and_flags.split('/', 2);
                var word = parts[0];

                if (parts.length > 1) {
                    // Word has affix rules - parse and expand them
                    var ruleCodesArray = this.parseRuleCodes(parts[1]);
                    this._expandWordWithAffixes(word, ruleCodesArray, dictionaryTable);
                }
                else {
                    // Word has no affix rules - add it as-is
                    this._addWordToDictionary(dictionaryTable, word.trim(), []);
                }
                
                if (this.loadingCallback && (i % 1000 === 0)) {
                    this.loadingCallback('dic', i, totalEntries);
                }
            }
            
            if (this.loadingCallback) {
                this.loadingCallback('dic', totalEntries, totalEntries);
            }

            return dictionaryTable;
        },
        /**
         * Removes comment lines and then cleans up blank lines and trailing whitespace.
         *
         * @param {string} data The data from a .dic file.
         * @return {string} The cleaned-up data.
         */
        _removeDicComments: function (data) {
            // I can't find any official documentation on it, but at least the de_DE
            // dictionary uses tab-indented lines as comments.
            // Remove comments
            data = data.replace(/^\t.*$/mg, "");
            return data;
        },
        parseRuleCodes: function (textCodes) {
            if (!textCodes) {
                return [];
            }
            else if (!("FLAG" in this.flags)) {
                // The flag symbols are single characters
                return textCodes.split("");
            }
            else if (this.flags.FLAG === "long") {
                // The flag symbols are two characters long.
                var flags = [];
                for (var i = 0, _len = textCodes.length; i < _len; i += 2) {
                    flags.push(textCodes.substr(i, 2));
                }
                return flags;
            }
            else if (this.flags.FLAG === "num") {
                // The flag symbols are a CSV list of numbers.
                return textCodes.split(",");
            }
            else if (this.flags.FLAG === "UTF-8") {
                // The flags are single UTF-8 characters.
                // @see https://github.com/cfinke/Typo.js/issues/57
                return Array.from(textCodes);
            }
            else {
                // It's possible that this fallback case will not work for all FLAG values,
                // but I think it's more likely to work than not returning anything at all.
                return textCodes.split("");
            }
        },
        /**
         * Maximum recursion depth for following continuation classes in affix rules.
         * This prevents infinite loops when continuation classes form cycles
         * (e.g., rule A references rule B which references rule A).
         * Hunspell itself imposes similar limits.
         */
        _maxAffixDepth: 5,
        
        /**
         * Applies an affix rule to a word.
         *
         * @param {string} word The base word.
         * @param {Object} rule The affix rule.
         * @param {number} [_depth=0] Current recursion depth (internal use).
         * @returns {string[]} The new words generated by the rule.
         */
        _applyRule: function (word, rule, _depth) {
            _depth = _depth || 0;
            var entries = rule.entries;
            var newWords = [];
            var testRegex = this._testRegex;
            var maxDepth = this._maxAffixDepth;
            var rules = this.rules;
            var maxExpansions = this._maxExpansionsPerWord;
            for (var i = 0, _len = entries.length; i < _len; i++) {
                if (this._expansionCount >= maxExpansions) {
                    break;
                }
                var entry = entries[i];
                if (!entry.match || testRegex(entry.match, word)) {
                    var newWord = word;
                    if (entry.remove) {
                        newWord = newWord.replace(entry.remove, "");
                    }
                    if (rule.type === "SFX") {
                        newWord = newWord + entry.add;
                    }
                    else {
                        newWord = entry.add + newWord;
                    }
                    newWords.push(newWord);
                    this._expansionCount++;
                    if ("continuationClasses" in entry) {
                        if (_depth < maxDepth) {
                            for (var j = 0, _jlen = entry.continuationClasses.length; j < _jlen; j++) {
                                if (this._expansionCount >= maxExpansions) {
                                    break;
                                }
                                var continuationRule = rules[entry.continuationClasses[j]];
                                if (continuationRule) {
                                    newWords = newWords.concat(this._applyRule(newWord, continuationRule, _depth + 1));
                                }
                            /*
                            else {
                                // This shouldn't happen, but it does, at least in the de_DE dictionary.
                                // I think the author mistakenly supplied lower-case rule codes instead
                                // of upper-case.
                            }
                            */
                            }
                        } else {
                            this._depthLimitHit = true;
                        }
                    }
                }
            }
            return newWords;
        },
        /**
         * Checks whether a word or a capitalization variant exists in the current dictionary.
         * The word is trimmed and several variations of capitalizations are checked.
         * If you want to check a word without any changes made to it, call checkExact()
         *
         * @see http://blog.stevenlevithan.com/archives/faster-trim-javascript re:trimming function
         *
         * @param {string} aWord The word to check.
         * @returns {boolean}
         */
        check: function (aWord) {
            if (!this.loaded) {
                throw "Dictionary not loaded.";
            }
            if (!aWord) {
                return false;
            }
            // Remove leading and trailing whitespace
            var trimmedWord = aWord.replace(/^\s\s*/, '').replace(/\s\s*$/, '');
            if (this.checkExact(trimmedWord)) {
                return true;
            }
            // The exact word is not in the dictionary.
            if (trimmedWord.toUpperCase() === trimmedWord) {
                // The word was supplied in all uppercase.
                // Check for a capitalized form of the word.
                var capitalizedWord = trimmedWord[0] + trimmedWord.substring(1).toLowerCase();
                if (this.hasFlag(capitalizedWord, "KEEPCASE")) {
                    // Capitalization variants are not allowed for this word.
                    return false;
                }
                if (this.checkExact(capitalizedWord)) {
                    // The all-caps word is a capitalized word spelled correctly.
                    return true;
                }
                if (this.checkExact(trimmedWord.toLowerCase())) {
                    // The all-caps is a lowercase word spelled correctly.
                    return true;
                }
            }
            var uncapitalizedWord = trimmedWord[0].toLowerCase() + trimmedWord.substring(1);
            if (uncapitalizedWord !== trimmedWord) {
                if (this.hasFlag(uncapitalizedWord, "KEEPCASE")) {
                    // Capitalization variants are not allowed for this word.
                    return false;
                }
                // Check for an uncapitalized form
                if (this.checkExact(uncapitalizedWord)) {
                    // The word is spelled correctly but with the first letter capitalized.
                    return true;
                }
            }
            return false;
        },
        /**
         * Checks whether a word exists in the current dictionary.
         *
         * @param {string} word The word to check.
         * @returns {boolean}
         */
        checkExact: function (word) {
            if (!this.loaded) {
                throw "Dictionary not loaded.";
            }
            
            // Both traditional and pre-parsed modes use dictionaryTable
            var ruleCodes = this.dictionaryTable.get(word);
            var i, _len;
            if (typeof ruleCodes === 'undefined') {
                // Check if this might be a compound word.
                if ("COMPOUNDMIN" in this.flags && word.length >= this.flags.COMPOUNDMIN) {
                    for (i = 0, _len = this.compoundRules.length; i < _len; i++) {
                        if (word.match(this.compoundRules[i])) {
                            return true;
                        }
                    }
                }
            }
            else if (ruleCodes === null) {
                // a null (but not undefined) value for an entry in the dictionary table
                // means that the word is in the dictionary but has no flags.
                return true;
            }
            else if (typeof ruleCodes === 'object') { // ruleCodes is an array of rule sets
                for (i = 0, _len = ruleCodes.length; i < _len; i++) {
                    if (!this.hasFlag(word, "ONLYINCOMPOUND", ruleCodes[i])) {
                        return true;
                    }
                }
            }
            return false;
        },
        /**
         * Looks up whether a given word is flagged with a given flag.
         *
         * @param {string} word The word in question.
         * @param {string} flag The flag in question.
         * @return {boolean}
         */
        hasFlag: function (word, flag, wordFlags) {
            if (!this.loaded) {
                throw "Dictionary not loaded.";
            }
            if (flag in this.flags) {
                if (typeof wordFlags === 'undefined') {
                    // Get word flags from dictionaryTable (same structure in
                    // both traditional and pre-parsed modes)
                    var entry = this.dictionaryTable.get(word);
                    wordFlags = entry ? Array.prototype.concat.apply([], entry) : [];
                }
                if (wordFlags && wordFlags.indexOf(this.flags[flag]) !== -1) {
                    return true;
                }
            }
            return false;
        },
        /**
         * Returns a list of suggestions for a misspelled word.
         *
         * @see http://www.norvig.com/spell-correct.html for the basis of this suggestor.
         * This suggestor is primitive, but it works.
         *
         * @param {string} word The misspelling.
         * @param {number} [limit=5] The maximum number of suggestions to return.
         * @returns {string[]} The array of suggestions.
         */
        alphabet: "",
        suggest: function (word, limit) {
            if (!this.loaded) {
                throw "Dictionary not loaded.";
            }
            limit = limit || 5;
            if (this.memoized.hasOwnProperty(word)) {
                var memoizedLimit = this.memoized[word]['limit'];
                // Only return the cached list if it's big enough or if there weren't enough suggestions
                // to fill a smaller limit.
                if (limit <= memoizedLimit || this.memoized[word]['suggestions'].length < memoizedLimit) {
                    return this.memoized[word]['suggestions'].slice(0, limit);
                }
            }
            if (this.check(word))
                return [];
            // Check the replacement table.
            for (var i = 0, _len = this.replacementTable.length; i < _len; i++) {
                var replacementEntry = this.replacementTable[i];
                if (word.indexOf(replacementEntry[0]) !== -1) {
                    var correctedWord = word.replace(replacementEntry[0], replacementEntry[1]);
                    if (this.check(correctedWord)) {
                        return [correctedWord];
                    }
                }
            }
            if (!this.alphabet) {
                // Use the English alphabet as the default. Problematic, but backwards-compatible.
                this.alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
                // Any characters defined in the affix file as substitutions can go in the alphabet too.
                // Note that dictionaries do not include the entire alphabet in the TRY flag when it's there.
                // For example, Q is not in the default English TRY list; that's why having the default
                // alphabet above is useful.
                if ('TRY' in this.flags) {
                    this.alphabet += this.flags['TRY'];
                }
                // Plus any additional characters specifically defined as being allowed in words.
                if ('WORDCHARS' in this.flags) {
                    this.alphabet += this.flags['WORDCHARS'];
                }
                // Remove any duplicates.
                var alphaArray = this.alphabet.split("");
                alphaArray.sort();
                var alphaHash = {};
                for (var i = 0; i < alphaArray.length; i++) {
                    alphaHash[alphaArray[i]] = true;
                }
                this.alphabet = '';
                for (var i in alphaHash) {
                    this.alphabet += i;
                }
            }
            var self = this;
            /**
             * Returns a hash keyed by all of the strings that can be made by making a single edit to the word (or words in) `words`
             * The value of each entry is the number of unique ways that the resulting word can be made.
             *
             * @arg HashMap words A hash keyed by words (all with the value `true` to make lookups very quick).
             * @arg boolean known_only Whether this function should ignore strings that are not in the dictionary.
             */
            function edits1(words, known_only) {
                var rv = {};
                var i, j, _iilen, _len, _jlen, _edit;
                var alphabetLength = self.alphabet.length;
                for (var word_1 in words) {
                    for (i = 0, _len = word_1.length + 1; i < _len; i++) {
                        var s = [word_1.substring(0, i), word_1.substring(i)];
                        // Remove a letter.
                        if (s[1]) {
                            _edit = s[0] + s[1].substring(1);
                            if (!known_only || self.check(_edit)) {
                                if (!(_edit in rv)) {
                                    rv[_edit] = 1;
                                }
                                else {
                                    rv[_edit] += 1;
                                }
                            }
                        }
                        // Transpose letters
                        // Eliminate transpositions of identical letters
                        if (s[1].length > 1 && s[1][1] !== s[1][0]) {
                            _edit = s[0] + s[1][1] + s[1][0] + s[1].substring(2);
                            if (!known_only || self.check(_edit)) {
                                if (!(_edit in rv)) {
                                    rv[_edit] = 1;
                                }
                                else {
                                    rv[_edit] += 1;
                                }
                            }
                        }
                        if (s[1]) {
                            // Replace a letter with another letter.
                            var lettercase = (s[1].substring(0, 1).toUpperCase() === s[1].substring(0, 1)) ? 'uppercase' : 'lowercase';
                            for (j = 0; j < alphabetLength; j++) {
                                var replacementLetter = self.alphabet[j];
                                // Set the case of the replacement letter to the same as the letter being replaced.
                                if ('uppercase' === lettercase) {
                                    replacementLetter = replacementLetter.toUpperCase();
                                }
                                // Eliminate replacement of a letter by itself
                                if (replacementLetter != s[1].substring(0, 1)) {
                                    _edit = s[0] + replacementLetter + s[1].substring(1);
                                    if (!known_only || self.check(_edit)) {
                                        if (!(_edit in rv)) {
                                            rv[_edit] = 1;
                                        }
                                        else {
                                            rv[_edit] += 1;
                                        }
                                    }
                                }
                            }
                        }
                        if (s[1]) {
                            // Add a letter between each letter.
                            for (j = 0; j < alphabetLength; j++) {
                                // If the letters on each side are capitalized, capitalize the replacement.
                                var lettercase = (s[0].substring(-1).toUpperCase() === s[0].substring(-1) && s[1].substring(0, 1).toUpperCase() === s[1].substring(0, 1)) ? 'uppercase' : 'lowercase';
                                var replacementLetter = self.alphabet[j];
                                if ('uppercase' === lettercase) {
                                    replacementLetter = replacementLetter.toUpperCase();
                                }
                                _edit = s[0] + replacementLetter + s[1];
                                if (!known_only || self.check(_edit)) {
                                    if (!(_edit in rv)) {
                                        rv[_edit] = 1;
                                    }
                                    else {
                                        rv[_edit] += 1;
                                    }
                                }
                            }
                        }
                    }
                }
                return rv;
            }
            function correct(word) {
                var _a;
                // Get the edit-distance-1 and edit-distance-2 forms of this word.
                var ed1 = edits1((_a = {}, _a[word] = true, _a));
                var ed2 = edits1(ed1, true);
                // Sort the edits based on how many different ways they were created.
                var weighted_corrections = ed2;
                for (var ed1word in ed1) {
                    if (!self.check(ed1word)) {
                        continue;
                    }
                    if (ed1word in weighted_corrections) {
                        weighted_corrections[ed1word] += ed1[ed1word];
                    }
                    else {
                        weighted_corrections[ed1word] = ed1[ed1word];
                    }
                }
                var i, _len;
                var sorted_corrections = [];
                for (i in weighted_corrections) {
                    if (weighted_corrections.hasOwnProperty(i)) {
                        if (self.hasFlag(i, "PRIORITYSUGGEST")) {
                            // We've defined a new affix rule called PRIORITYSUGGEST, indicating that
                            // if this word is in the suggestions list for a misspelled word, it should
                            // be given priority over other suggestions.
                            //
                            // Add a large number to its weight to push it to the top of the list.
                            // If multiple priority suggestions are in the list, they'll still be ranked
                            // against each other, but they'll all be above non-priority suggestions.
                            weighted_corrections[i] += 1000;
                        }
                        sorted_corrections.push([i, weighted_corrections[i]]);
                    }
                }
                function sorter(a, b) {
                    var a_val = a[1];
                    var b_val = b[1];
                    if (a_val < b_val) {
                        return -1;
                    }
                    else if (a_val > b_val) {
                        return 1;
                    }
                    // @todo If a and b are equally weighted, add our own weight based on something like the key locations on this language's default keyboard.
                    return b[0].localeCompare(a[0]);
                }
                sorted_corrections.sort(sorter).reverse();
                var rv = [];
                var capitalization_scheme = "lowercase";
                if (word.toUpperCase() === word) {
                    capitalization_scheme = "uppercase";
                }
                else if (word.substr(0, 1).toUpperCase() + word.substr(1).toLowerCase() === word) {
                    capitalization_scheme = "capitalized";
                }
                var working_limit = limit;
                for (i = 0; i < Math.min(working_limit, sorted_corrections.length); i++) {
                    if ("uppercase" === capitalization_scheme) {
                        sorted_corrections[i][0] = sorted_corrections[i][0].toUpperCase();
                    }
                    else if ("capitalized" === capitalization_scheme) {
                        sorted_corrections[i][0] = sorted_corrections[i][0].substr(0, 1).toUpperCase() + sorted_corrections[i][0].substr(1);
                    }
                    if (!self.hasFlag(sorted_corrections[i][0], "NOSUGGEST") && rv.indexOf(sorted_corrections[i][0]) === -1) {
                        rv.push(sorted_corrections[i][0]);
                    }
                    else {
                        // If one of the corrections is not eligible as a suggestion , make sure we still return the right number of suggestions.
                        working_limit++;
                    }
                }
                return rv;
            }
            this.memoized[word] = {
                'suggestions': correct(word),
                'limit': limit
            };
            return this.memoized[word]['suggestions'];
        },
        
        /**
         * ========================================================================
         * PRE-PARSED DICTIONARY METHODS
         * ========================================================================
         */
        
        /**
         * Load pre-parsed dictionary from a single gzipped JSON file (asynchronous).
         * 
         * Fetches <preParsedPath>/<language>/dictionary.json.gz, decompresses it,
         * and populates the same dictionaryTable / compoundRules / flags /
         * replacementTable structures that the traditional .aff/.dic parser builds.
         * After loading, the standard check / checkExact / hasFlag / suggest methods
         * work identically to traditional mode — no special runtime code paths needed.
         * 
         * @param {Function} callback Called when loading is complete.
         * @private
         */
        _loadPreParsedAsync: function(callback) {
            var self = this;
            var url = this.preParsedPath + '/' + this.dictionary + '/dictionary.json.gz';
            
            fetch(url).then(function(response) {
                if (!response.ok) {
                    throw new Error('HTTP ' + response.status + ' loading ' + url);
                }
                
                // Decompress the gzipped response using the Compression Streams API
                var decompressed = response.body.pipeThrough(new DecompressionStream('gzip'));
                return new Response(decompressed).json();
            }).then(function(data) {
                // Version check
                if (data.version !== PREPARSED_FORMAT_VERSION) {
                    throw new Error(
                        "Unsupported pre-parsed dictionary version: " + data.version +
                        ". Expected version " + PREPARSED_FORMAT_VERSION + "."
                    );
                }
                
                // Build dictionaryTable Map from the two-part storage format:
                //   words[]        → unflagged entries (stored as null in the Map)
                //   flaggedWords{} → entries with rule code arrays
                var map = new Map();
                
                var words = data.words;
                for (var i = 0, len = words.length; i < len; i++) {
                    map.set(words[i], null);
                }
                
                var flagged = data.flaggedWords;
                for (var word in flagged) {
                    if (flagged.hasOwnProperty(word)) {
                        map.set(word, flagged[word]);
                    }
                }
                
                self.dictionaryTable = map;
                
                // Restore compound rules (deserialize RegExp objects)
                self.compoundRules = [];
                if (data.compoundRules) {
                    for (var j = 0; j < data.compoundRules.length; j++) {
                        var ruleData = data.compoundRules[j];
                        self.compoundRules.push(new RegExp(ruleData.source, ruleData.flags));
                    }
                }
                
                self.flags = data.flags || {};
                self.replacementTable = data.replacementTable || [];
                
                self.loaded = true;
                if (callback) callback();
            }).catch(function(error) {
                console.error('Failed to load pre-parsed dictionary:', error);
                throw error;
            });
        },
        
        /**
         * Export the current dictionary for pre-parsed mode.
         * This should be called after loading a traditional .aff/.dic dictionary.
         * 
         * The exported object contains two top-level keys:
         *   - dictionary: the data to be serialized and loaded at runtime
         *   - diagnostics: expansion statistics for analysis (not saved to file)
         * 
         * The dictionary object stores unflagged words as a sorted string array
         * and flagged words (those with rule codes) as an object, keeping the
         * file compact and the load-time Map construction straightforward.
         * 
         * @param {Function} [progressCallback] Optional callback for progress updates.
         *        Called with object: { phase: string, current: number, total: number }
         *        Phases: 'collecting', 'sorting', 'complete'
         * @returns {Object} { dictionary: {...}, diagnostics: {...} }
         */
        exportPreParsed: function(progressCallback) {
            if (!this.loaded) {
                throw "Dictionary must be loaded before exporting";
            }
            
            if (this.preParsed) {
                throw "Cannot export a pre-parsed dictionary";
            }
            
            // Helper to report progress
            var reportProgress = function(phase, current, total) {
                if (progressCallback) {
                    progressCallback({ phase: phase, current: current, total: total });
                }
            };
            
            // Separate words into unflagged (null rules) and flagged
            reportProgress('collecting', 0, 1);
            var words = [];
            var flaggedWords = {};
            var totalWords = 0;
            
            this.dictionaryTable.forEach(function(rules, word) {
                totalWords++;
                if (rules === null) {
                    words.push(word);
                } else {
                    flaggedWords[word] = rules;
                }
            });
            reportProgress('collecting', totalWords, totalWords);
            
            // Sort unflagged words for better gzip compression
            // (similar prefixes cluster together, improving deflate ratio)
            reportProgress('sorting', 0, 1);
            words.sort(compareStrings);
            reportProgress('sorting', 1, 1);
            
            // Serialize compound rules (RegExp → {source, flags})
            var compoundRules = [];
            for (var i = 0; i < this.compoundRules.length; i++) {
                var rule = this.compoundRules[i];
                compoundRules.push({
                    source: rule.source,
                    flags: rule.flags
                });
            }
            
            var flaggedWordCount = Object.keys(flaggedWords).length;
            
            reportProgress('complete', totalWords, totalWords);
            
            return {
                dictionary: {
                    version: PREPARSED_FORMAT_VERSION,
                    language: this.dictionary,
                    totalWords: totalWords,
                    flaggedWordCount: flaggedWordCount,
                    words: words,
                    flaggedWords: flaggedWords,
                    compoundRules: compoundRules,
                    flags: this.flags,
                    replacementTable: this.replacementTable
                },
                diagnostics: {
                    expansionLimitHits: this._expansionLimitHits,
                    depthLimitHits: this._depthLimitHits,
                    expansionHistogram: this._summarizeHistogram()
                }
            };
        }
    };
})();
// Support for use as a node.js module.
if (typeof module !== 'undefined') {
    module.exports = Typo;
}

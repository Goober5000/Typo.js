/* globals chrome: false */
/* globals __dirname: false */
/* globals require: false */
/* globals Buffer: false */
/* globals module: false */
/**
 * Typo is a JavaScript implementation of a spellchecker using hunspell-style
 * dictionaries.
 * 
 * ENHANCED VERSION: Supports both traditional .aff/.dic loading and pre-calculated
 * paged word lists for large dictionaries.
 */
var Typo;
(function () {
    "use strict";
    
    /**
     * Version of the pre-calculated dictionary format.
     * Increment this when making breaking changes to the format.
     */
    var PRECALC_FORMAT_VERSION = 1;
    
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
     * Simple Bloom Filter implementation for fast negative lookups.
     * Uses multiple hash functions to minimize false positives.
     */
    function BloomFilter(size, numHashes) {
        this.size = size;
        this.numHashes = numHashes || 3;
        this.bits = new Uint8Array(Math.ceil(size / 8));
    }
    
    BloomFilter.prototype = {
        /**
         * Add a word to the bloom filter
         */
        add: function(word) {
            for (var i = 0; i < this.numHashes; i++) {
                var hash = this._hash(word, i);
                var bitIndex = hash % this.size;
                var byteIndex = Math.floor(bitIndex / 8);
                var bitOffset = bitIndex % 8;
                this.bits[byteIndex] |= (1 << bitOffset);
            }
        },
        
        /**
         * Check if a word might be in the set (may have false positives)
         */
        mightContain: function(word) {
            for (var i = 0; i < this.numHashes; i++) {
                var hash = this._hash(word, i);
                var bitIndex = hash % this.size;
                var byteIndex = Math.floor(bitIndex / 8);
                var bitOffset = bitIndex % 8;
                if ((this.bits[byteIndex] & (1 << bitOffset)) === 0) {
                    return false; // Definitely not present
                }
            }
            return true; // Might be present
        },
        
        /**
         * Simple hash function (DJB2 variant)
         */
        _hash: function(str, seed) {
            var hash = 5381 + (seed * 1000);
            for (var i = 0; i < str.length; i++) {
                hash = ((hash << 5) + hash) + str.charCodeAt(i);
                hash = hash >>> 0; // Convert to 32-bit unsigned integer
            }
            return hash;
        },
        
        /**
         * Export bloom filter to JSON-serializable format
         */
        toJSON: function() {
            return {
                size: this.size,
                numHashes: this.numHashes,
                bits: Array.from(this.bits)
            };
        },
        
        /**
         * Create bloom filter from JSON data
         */
        fromJSON: function(data) {
            this.size = data.size;
            this.numHashes = data.numHashes;
            this.bits = new Uint8Array(data.bits);
            return this;
        }
    };
    
    /**
     * Efficient LRU cache using Map (maintains insertion order)
     * All operations are O(1) amortized.
     */
    function LRUCache(maxSize) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }
    
    LRUCache.prototype = {
        /**
         * Get a value and mark it as recently used
         */
        get: function(key) {
            if (!this.cache.has(key)) {
                return null;
            }
            // Move to end: delete and re-add to update position
            var value = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, value);
            return value;
        },
        
        /**
         * Set a value (adds or updates)
         */
        set: function(key, value) {
            // If exists, delete first to update position
            if (this.cache.has(key)) {
                this.cache.delete(key);
            }
            
            this.cache.set(key, value);
            
            // Evict oldest if over capacity
            if (this.cache.size > this.maxSize) {
                // Map.keys().next().value gives the oldest (first inserted) key
                var oldestKey = this.cache.keys().next().value;
                this.cache.delete(oldestKey);
            }
        },
        
        /**
         * Check if key exists (without updating access order)
         */
        has: function(key) {
            return this.cache.has(key);
        },
        
        /**
         * Add a key with a trivial value (for Set-like usage)
         */
        add: function(key) {
            this.set(key, true);
        }
    };
    
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
     *                              {boolean} [preCalculated]: If true, load from pre-calculated word lists
     *                              instead of .aff/.dic files. Requires preCalculatedPath.
     *                              {string} [preCalculatedPath]: Path to pre-calculated dictionary files.
     *                              {number} [partitionCacheSize]: Number of partitions to keep in cache (default: 20)
     *
     * @returns {Typo} A Typo object.
     */
    Typo = function (dictionary, affData, wordsData, settings) {
        settings = settings || {};
        this.dictionary = null;
        this.rules = {};
        this.dictionaryTable = {};
        this.compoundRules = [];
        this.compoundRuleCodes = {};
        this.replacementTable = [];
        this.flags = settings.flags || {};
        this.memoized = {};
        this.loaded = false;
        
        // Pre-calculated dictionary support
        this.preCalculated = settings.preCalculated || false;
        this.preCalculatedPath = settings.preCalculatedPath || null;
        this.bloomFilter = null;
        this.partitionIndex = null;
        this.partitionCache = null;
        this.notFoundCache = null;
        
        if (this.preCalculated) {
            this.partitionCache = new LRUCache(settings.partitionCacheSize || 20);
            this.notFoundCache = new LRUCache(settings.notFoundCacheSize || 10000);
        }
        
        var self = this;
        var path;
        // Loop-control variables.
        var i, j, _len, _jlen;
        if (dictionary) {
            self.dictionary = dictionary;
            
            // PRE-CALCULATED MODE: Load from pre-calculated files
            if (self.preCalculated && self.preCalculatedPath) {
                if (settings.asyncLoad) {
                    self._loadPreCalculatedAsync(function() {
                        if (settings.loadedCallback) {
                            settings.loadedCallback(self);
                        }
                    });
                } else {
                    self._loadPreCalculated();
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
         * Parses the words out from the .dic file.
         *
         * @param {string} data The data from the dictionary file.
         * @returns HashMap The lookup table containing all of the words and
         *                 word forms from the dictionary.
         */
        /**
         * Adds a word to the dictionary table with its associated rule codes.
         * Some dictionaries list the same word multiple times with different rule sets.
         * 
         * @param {Object} dictionaryTable The dictionary table to add to
         * @param {string} word The word to add
         * @param {Array} rules The rule codes associated with this word
         */
        _addWordToDictionary: function (dictionaryTable, word, rules) {
            if (!dictionaryTable.hasOwnProperty(word)) {
                dictionaryTable[word] = null;
            }
            if (rules.length > 0) {
                if (dictionaryTable[word] === null) {
                    dictionaryTable[word] = [];
                }
                dictionaryTable[word].push(rules);
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
         * @param {Object} dictionaryTable The dictionary table to populate
         */
        _applyRuleCombinations: function (word, baseRule, baseRuleIndex, allRuleCodes, dictionaryTable) {
            // Try combining with subsequent rules in the list
            for (var i = baseRuleIndex + 1, len = allRuleCodes.length; i < len; i++) {
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
         * @param {Object} dictionaryTable The dictionary table to populate
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
            for (var i = 0, len = generatedWords.length; i < len; i++) {
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
         * Expands a word by applying all its affix rules and combinations.
         * This is the main entry point for affix expansion.
         * 
         * @param {string} word The base word from the dictionary
         * @param {Array} ruleCodesArray Array of rule codes to apply to this word
         * @param {Object} dictionaryTable The dictionary table to populate
         */
        _expandWordWithAffixes: function (word, ruleCodesArray, dictionaryTable) {
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
                var ruleCode = ruleCodesArray[i];

                // Apply the rule and handle combinations
                this._applySingleRuleToWord(word, ruleCode, i, ruleCodesArray, dictionaryTable);

                // Track for compound word formation
                this._trackCompoundWord(word, ruleCode);
            }
        },

        /**
         * Parses the dictionary file and builds the in-memory dictionary table.
         * Each word is expanded by applying its affix rules to generate all valid forms.
         * 
         * @param {string} data The contents of a .dic file
         * @returns {Object} The populated dictionary table
         */
        _parseDIC: function (data) {
            data = this._removeDicComments(data);
            var lines = data.split(/\r?\n/);
            var dictionaryTable = {};

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
         * Applies an affix rule to a word.
         *
         * @param {string} word The base word.
         * @param {Object} rule The affix rule.
         * @returns {string[]} The new words generated by the rule.
         */
        _applyRule: function (word, rule) {
            var entries = rule.entries;
            var newWords = [];
            for (var i = 0, _len = entries.length; i < _len; i++) {
                var entry = entries[i];
                if (!entry.match || word.match(entry.match)) {
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
                    if ("continuationClasses" in entry) {
                        for (var j = 0, _jlen = entry.continuationClasses.length; j < _jlen; j++) {
                            var continuationRule = this.rules[entry.continuationClasses[j]];
                            if (continuationRule) {
                                newWords = newWords.concat(this._applyRule(newWord, continuationRule));
                            }
                            /*
                            else {
                                // This shouldn't happen, but it does, at least in the de_DE dictionary.
                                // I think the author mistakenly supplied lower-case rule codes instead
                                // of upper-case.
                            }
                            */
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
            
            // PRE-CALCULATED MODE: Use bloom filter + paging
            if (this.preCalculated) {
                return this._checkPreCalculated(word);
            }
            
            // TRADITIONAL MODE: Use dictionaryTable
            var ruleCodes = this.dictionaryTable[word];
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
            else if (typeof ruleCodes === 'object') { // this.dictionary['hasOwnProperty'] will be a function.
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
                    // Get word flags from appropriate source
                    if (this.preCalculated) {
                        // PRE-CALCULATED MODE: Load partition and find word's rules
                        var prefix = this._getPartitionPrefix(word);
                        var words = this._loadPartition(prefix);  // Uses LRU cache
                        var rules = this._findWordRules(words, word);
                        if (rules) {
                            wordFlags = Array.prototype.concat.apply([], rules);
                        }
                    } else {
                        // TRADITIONAL MODE: Use dictionaryTable
                        wordFlags = Array.prototype.concat.apply([], this.dictionaryTable[word]);
                    }
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
         * PRE-CALCULATED DICTIONARY METHODS
         * ========================================================================
         */
        
        /**
         * Enhanced checkExact that supports both traditional and pre-calculated modes
         * @param {string} word The word to check
         * @returns {boolean|Promise<boolean>} True if word exists (or Promise in async mode)
         */
        checkExactEnhanced: function(word) {
            if (!this.loaded) {
                throw "Dictionary not loaded.";
            }
            
            // PRE-CALCULATED MODE
            if (this.preCalculated) {
                return this._checkPreCalculated(word);
            }
            
            // TRADITIONAL MODE - use original logic
            return this.checkExact(word);
        },
        
        /**
         * Load pre-calculated dictionary from JSON files (synchronous)
         * @private
         */
        _loadPreCalculated: function() {
            var self = this;
            var basePath = this.preCalculatedPath + '/' + this.dictionary;
            
            // Load index
            var indexData = this._readFile(basePath + '/index.json');
            var index = JSON.parse(indexData);
            
            // Version check
            if (index.version !== PRECALC_FORMAT_VERSION) {
                throw "Unsupported pre-calculated dictionary version: " + index.version + 
                      ". Expected version " + PRECALC_FORMAT_VERSION + ".";
            }
            
            this.partitionIndex = index.partitions;
            
            // Load and initialize bloom filter
            var bloomData = this._readFile(basePath + '/bloom.json');
            var bloomJson = JSON.parse(bloomData);
            this.bloomFilter = new BloomFilter(bloomJson.size, bloomJson.numHashes);
            this.bloomFilter.fromJSON(bloomJson);
            
            // Load compound word rules and flags
            var compoundData = this._readFile(basePath + '/compound.json');
            var compoundJson = JSON.parse(compoundData);
            
            // Restore compound rules (deserialize RegExp objects)
            this.compoundRules = [];
            for (var i = 0; i < compoundJson.compoundRules.length; i++) {
                var ruleData = compoundJson.compoundRules[i];
                this.compoundRules.push(new RegExp(ruleData.source, ruleData.flags));
            }
            
            this.compoundRuleCodes = compoundJson.compoundRuleCodes;
            this.flags = compoundJson.flags;
            this.replacementTable = compoundJson.replacementTable || [];  // For suggest() support
            
            // Load rules dictionary for hasFlag support
            var rulesData = this._readFile(basePath + '/rules.json');
            this.rules = JSON.parse(rulesData);
            
            this.loaded = true;
        },
        
        /**
         * Load pre-calculated dictionary from JSON files (asynchronous)
         * @private
         */
        _loadPreCalculatedAsync: function(callback) {
            var self = this;
            var basePath = this.preCalculatedPath + '/' + this.dictionary;
            
            // Load index, bloom filter, compound data, and rules
            var indexPromise = this._readFile(basePath + '/index.json', 'utf8', true);
            var bloomPromise = this._readFile(basePath + '/bloom.json', 'utf8', true);
            var compoundPromise = this._readFile(basePath + '/compound.json', 'utf8', true);
            var rulesPromise = this._readFile(basePath + '/rules.json', 'utf8', true);
            
            Promise.all([indexPromise, bloomPromise, compoundPromise, rulesPromise]).then(function(results) {
                var index = JSON.parse(results[0]);
                
                // Version check
                if (index.version !== PRECALC_FORMAT_VERSION) {
                    throw "Unsupported pre-calculated dictionary version: " + index.version + 
                          ". Expected version " + PRECALC_FORMAT_VERSION + ".";
                }
                
                self.partitionIndex = index.partitions;
                
                var bloomJson = JSON.parse(results[1]);
                self.bloomFilter = new BloomFilter(bloomJson.size, bloomJson.numHashes);
                self.bloomFilter.fromJSON(bloomJson);
                
                var compoundJson = JSON.parse(results[2]);
                
                // Restore compound rules (deserialize RegExp objects)
                self.compoundRules = [];
                for (var i = 0; i < compoundJson.compoundRules.length; i++) {
                    var ruleData = compoundJson.compoundRules[i];
                    self.compoundRules.push(new RegExp(ruleData.source, ruleData.flags));
                }
                
                self.compoundRuleCodes = compoundJson.compoundRuleCodes;
                self.flags = compoundJson.flags;
                self.replacementTable = compoundJson.replacementTable || [];  // For suggest() support
                
                // Load rules dictionary for hasFlag support
                self.rules = JSON.parse(results[3]);
                
                self.loaded = true;
                if (callback) callback();
            }).catch(function(error) {
                console.error('Failed to load pre-calculated dictionary:', error);
                throw error;
            });
        },
        
        /**
         * Load a word partition from file (with caching)
         * @param {string} prefix - The partition prefix (e.g., "ab", "he")
         * @returns {Array} Array of word objects {w: word, r: rules} in this partition
         * @private
         */
        _loadPartition: function(prefix) {
            // Check cache first
            if (this.partitionCache.has(prefix)) {
                return this.partitionCache.get(prefix);
            }
            
            // Load from file
            var partitionInfo = this.partitionIndex[prefix];
            if (!partitionInfo) {
                return [];
            }
            
            var basePath = this.preCalculatedPath + '/' + this.dictionary;
            var partitionData = this._readFile(basePath + '/' + partitionInfo.file);
            var partition = JSON.parse(partitionData);
            
            // Cache partition
            this.partitionCache.set(prefix, partition.words);
            
            return partition.words;
        },
        
        /**
         * Binary search for a word in a sorted array of word objects
         * @param {Array} words - Sorted array of word objects {w: word, r: rules}
         * @param {string} target - Word to find
         * @returns {boolean} True if word found
         * @private
         */
        _binarySearch: function(words, target) {
            var left = 0;
            var right = words.length - 1;
            
            while (left <= right) {
                var mid = Math.floor((left + right) / 2);
                var wordData = words[mid];
                var comparison = compareStrings(wordData.w, target);
                
                if (comparison === 0) {
                    return true;
                } else if (comparison < 0) {
                    left = mid + 1;
                } else {
                    right = mid - 1;
                }
            }
            
            return false;
        },
        
        /**
         * Binary search to find a word's rule codes in a sorted partition
         * @param {Array} words - Sorted array of word objects {w: word, r: rules}
         * @param {string} target - Word to find
         * @returns {Array|null} Rule codes array if found, null otherwise
         * @private
         */
        _findWordRules: function(words, target) {
            var left = 0;
            var right = words.length - 1;
            
            while (left <= right) {
                var mid = Math.floor((left + right) / 2);
                var wordData = words[mid];
                var comparison = compareStrings(wordData.w, target);
                
                if (comparison === 0) {
                    return wordData.r;  // Return rules (may be null)
                } else if (comparison < 0) {
                    left = mid + 1;
                } else {
                    right = mid - 1;
                }
            }
            
            return null;  // Word not found
        },
        
        /**
         * Get the partition prefix for a word.
         * Always returns a 2-character prefix, padding single-character words with '_'.
         * @param {string} word - The word to get the prefix for
         * @returns {string} A 2-character lowercase prefix
         * @private
         */
        _getPartitionPrefix: function(word) {
            if (word.length >= 2) {
                return word.substring(0, 2).toLowerCase();
            } else {
                // Pad single-character words with underscore
                return ('_' + word).toLowerCase();
            }
        },
        
        /**
         * Check if a word exists in pre-calculated dictionary (synchronous)
         * @param {string} word - Word to check
         * @returns {boolean} True if word found
         * @private
         */
        _checkPreCalculated: function(word) {
            // Check negative cache first
            if (this.notFoundCache.has(word)) {
                return false;
            }
            
            // Check bloom filter (fast rejection of misspellings)
            if (!this.bloomFilter.mightContain(word)) {
                this.notFoundCache.add(word);
                return false;
            }
            
            // Determine partition
            var prefix = this._getPartitionPrefix(word);
            
            // Load partition and search
            var words = this._loadPartition(prefix);
            var found = this._binarySearch(words, word);
            
            if (!found) {
                // Check if this might be a compound word (using same logic as traditional mode)
                if ("COMPOUNDMIN" in this.flags && word.length >= this.flags.COMPOUNDMIN) {
                    for (var i = 0, _len = this.compoundRules.length; i < _len; i++) {
                        if (word.match(this.compoundRules[i])) {
                            return true;  // Valid compound word
                        }
                    }
                }
                
                this.notFoundCache.add(word);
            }
            
            return found;
        },
        
        /**
         * Export the current dictionary as pre-calculated word lists
         * This should be called after loading a traditional .aff/.dic dictionary
         * 
         * @param {Function} [progressCallback] Optional callback for progress updates.
         *        Called with object: { phase: string, current: number, total: number }
         *        Phases: 'collecting', 'sorting', 'bloom', 'partitioning', 'complete'
         * @returns {Object} Object containing all data needed for pre-calculated mode:
         *   {
         *     index: {...},        // Partition index
         *     bloom: {...},        // Bloom filter data
         *     partitions: {...}    // Map of prefix -> word array
         *   }
         */
        exportPreCalculated: function(progressCallback) {
            if (!this.loaded) {
                throw "Dictionary must be loaded before exporting";
            }
            
            if (this.preCalculated) {
                throw "Cannot export a pre-calculated dictionary";
            }
            
            // Helper to report progress
            var reportProgress = function(phase, current, total) {
                if (progressCallback) {
                    progressCallback({ phase: phase, current: current, total: total });
                }
            };
            
            // Collect all unique words from dictionaryTable with their rule codes
            reportProgress('collecting', 0, 1);
            var allWords = [];
            for (var word in this.dictionaryTable) {
                if (this.dictionaryTable.hasOwnProperty(word)) {
                    allWords.push({
                        word: word,
                        rules: this.dictionaryTable[word]  // null or array of rule arrays
                    });
                }
            }
            
            // Sort words using Unicode code point order for consistency
            reportProgress('sorting', 0, 1);
            allWords.sort(function(a, b) {
                return compareStrings(a.word, b.word);
            });
            
            var totalWords = allWords.length;
            console.log('Exporting ' + totalWords + ' words with rule codes...');
            
            // Create bloom filter (size = words * 10 bits, ~1% false positive rate)
            var bloomSize = totalWords * 10;
            var bloom = new BloomFilter(bloomSize, 3);
            
            // Add all words to bloom filter (with progress reporting)
            for (var i = 0; i < allWords.length; i++) {
                bloom.add(allWords[i].word);
                if (i % 10000 === 0) {
                    reportProgress('bloom', i, totalWords);
                }
            }
            reportProgress('bloom', totalWords, totalWords);
            
            // Partition words by first 2 characters (with padding for single-char words)
            var partitions = {};
            var partitionCounts = {};
            
            for (var i = 0; i < allWords.length; i++) {
                var wordData = allWords[i];
                var word = wordData.word;
                var prefix = this._getPartitionPrefix(word);
                
                if (!partitions[prefix]) {
                    partitions[prefix] = [];
                    partitionCounts[prefix] = 0;
                }
                
                // Store word with its rule codes
                partitions[prefix].push({
                    w: word,           // word
                    r: wordData.rules  // rules (null or array)
                });
                partitionCounts[prefix]++;
                
                if (i % 10000 === 0) {
                    reportProgress('partitioning', i, totalWords);
                }
            }
            reportProgress('partitioning', totalWords, totalWords);
            
            // Build index
            var index = {
                version: PRECALC_FORMAT_VERSION,
                language: this.dictionary,
                totalWords: totalWords,
                partitionCount: Object.keys(partitions).length,
                bloomFilterSize: bloomSize,
                partitions: {}
            };
            
            for (var prefix in partitionCounts) {
                index.partitions[prefix] = {
                    file: 'words/' + prefix + '.json',
                    count: partitionCounts[prefix]
                };
            }
            
            // Prepare partition data
            var partitionData = {};
            for (var prefix in partitions) {
                partitionData[prefix] = {
                    prefix: prefix,
                    words: partitions[prefix]  // Array of {w: word, r: rules}
                };
            }
            
            console.log('Export complete: ' + Object.keys(partitions).length + ' partitions');
            
            // Export compound word rules and flags for full feature parity
            var compoundData = {
                compoundRules: [],
                compoundRuleCodes: this.compoundRuleCodes,
                flags: this.flags,
                replacementTable: this.replacementTable  // For suggest() support
            };
            
            // Serialize RegExp objects to strings
            for (var i = 0; i < this.compoundRules.length; i++) {
                var rule = this.compoundRules[i];
                compoundData.compoundRules.push({
                    source: rule.source,
                    flags: rule.flags
                });
            }
            
            reportProgress('complete', totalWords, totalWords);
            
            return {
                index: index,
                bloom: bloom.toJSON(),
                partitions: partitionData,
                compound: compoundData,
                rules: this.rules  // Export rules dictionary for hasFlag
            };
        }
    };
})();
// Support for use as a node.js module.
if (typeof module !== 'undefined') {
    module.exports = Typo;
}

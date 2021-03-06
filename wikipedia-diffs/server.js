var fs = require('fs');
var $ = require('cheerio');
var irc = require('irc');
var request = require('request');
var express = require('express');
var http = require('http');
var app = express();
var server = http.createServer(app);
var socialNetworkSearch = require('./social-network-search.js');
var wiki2html = require('./wiki2html.js');

// verbous debug mode
var VERBOUS = true;
// really very verbous debug mode
var REALLY_VERBOUS = false;

// whether to only monitor the 1,000,000+ articles Wikipedias,
// or also the 100,000+ articles Wikipedias.
var MONITOR_LONG_TAIL_WIKIPEDIAS = true;

// required for Wikipedia API
var USER_AGENT = 'Wikipedia Live Monitor * IRC nick: wikipedia-live-monitor * Contact: tomac(a)google.com.';

// an article cluster is thrown out of the monitoring loop if its last edit is
// longer ago than SECONDS_SINCE_LAST_EDIT seconds
var SECONDS_SINCE_LAST_EDIT = 240;

// an article cluster may have at max SECONDS_BETWEEN_EDITS seconds in between
// edits in order to be regarded a breaking news candidate
var SECONDS_BETWEEN_EDITS = 60;

// an article cluster must have at least BREAKING_NEWS_THRESHOLD edits before it
// is considered a breaking news candidate
var BREAKING_NEWS_THRESHOLD = 5;

// an article cluster must be edited by at least NUMBER_OF_CONCURRENT_EDITORS
// concurrent editors before it is considered a breaking news candidate
var NUMBER_OF_CONCURRENT_EDITORS = 2;

// Wikipedia edit bots can account for many false positives, so usually we want
// to discard them
var DISCARD_WIKIPEDIA_BOTS = true;

// IRC details for the recent changes live updates
var IRC_SERVER = 'irc.wikimedia.org';
var IRC_NICK = 'wikipedia-live-monitor';

// IRC rooms are of the form #lang.wikipedia
// the list of languages is here:
// http://meta.wikimedia.org/wiki/List_of_Wikipedias#All_Wikipedias_ordered_by_number_of_articles
// http://meta.wikimedia.org/wiki/List_of_Wikipedias#1_000_000.2B_articles
var millionPlusLanguages = {
  en: true,
  de: true,
  fr: true,
  nl: true
};

// http://meta.wikimedia.org/wiki/List_of_Wikipedias#100_000.2B_articles
var oneHundredThousandPlusLanguages = {
  it: true,
  pl: true,
  es: true,
  ru: true,
  ja: true,
  pt: true,
  zh: true,
  vi: true,
  sv: true,
  uk: true,
  ca: true,
  no: true,
  fi: true,
  cs: true,
  fa: true,
  hu: true,
  ro: true,
  ko: true,
  ar: true,
  tr: true,
  id: true,
  sk: true,
  eo: true,
  da: true,
  kk: true,
  sr: true,
  lt: true,
  ms: true,
  he: true,
  eu: true,
  bg: true,
  sl: true,
  vo: true,
  hr: true,
  war: true,
  hi: true,
  et: true
};

var IRC_CHANNELS = [];
var PROJECT = '.wikipedia';
Object.keys(millionPlusLanguages).forEach(function(language) {
  if (millionPlusLanguages[language]) {
    IRC_CHANNELS.push('#' + language + PROJECT);
  }
});
if (MONITOR_LONG_TAIL_WIKIPEDIAS) {
  Object.keys(oneHundredThousandPlusLanguages).forEach(function(language) {
    if (oneHundredThousandPlusLanguages[language]) {
      IRC_CHANNELS.push('#' + language + PROJECT);
    }
  });
}

var client = new irc.Client(
    IRC_SERVER,
    IRC_NICK,
    {
      channels: IRC_CHANNELS
    });

// global objects, required to keep track of the currently monitored articles
// and article clusters for the different language versions
var articles = {};
var articleClusters = {};
var articleVersionsMap = {};

function monitorWikipedia(stream) {
  // fires whenever a new IRC message arrives on any of the IRC rooms
  client.addListener('message', function(from, to, message) {
    // this is the Wikipedia IRC bot that announces live changes
    if (from === 'rc-pmtpa') {
      // get the editor's username or IP address
      // the IRC log format is as follows (with color codes removed):
      // rc-pmtpa: [[Juniata River]] http://en.wikipedia.org/w/index.php?diff=516269072&oldid=514659029 * Johanna-Hypatia * (+67) Category:Place names of Native American origin in Pennsylvania
      var messageComponents = message.split('*');
      // remove color codes
      var regex = /\x0314\[\[\x0307(.+?)\x0314\]\]\x034.+?$/;
      var article = message.replace(regex, '$1');
      // discard non-article namespaces, as listed here:
      // http://www.mediawiki.org/wiki/Help:Namespaces
      // this means only listening to messages without a ':' essentially
      if (article.indexOf(':') === -1) {
        var editor = messageComponents[1]
            .replace(/\x0303/g, '')
            .replace(/\x035/g, '')
            .replace(/\u0003/g, '')
            .replace(/^\s*/, '')
            .replace(/\s*$/, '');
        // discard edits made by bots.
        // bots are identified by a B flag, as documented here
        // http://www.mediawiki.org/wiki/Help:Tracking_changes
        // (the 'b' is actually uppercase in IRC)
        //
        // bots must identify themselves by prefixing or suffixing their
        // username with "bot".
        // http://en.wikipedia.org/wiki/Wikipedia:Bot_policy#Bot_accounts
        var flags = messageComponents[0]
            .replace(/.*?\x034\s(.*?)\x0310.+$/, '$1');
        if (DISCARD_WIKIPEDIA_BOTS) {
          if ((/B/.test(flags)) ||
              (/^bot/i.test(editor)) ||
              (/bot$/i.test(editor))) {
            return;
          }
        }
        // normalize article titles to follow the Wikipedia URLs
        article = article.replace(/\s/g, '_');
        var now;
        // the language format follows the IRC room format: "#language.project"
        var language = to.substring(1, to.indexOf('.'));
        editor = language + ':' + editor;
        // used to get the language references for language clustering
        var languageClusterUrl = 'http://' + language +
            '.wikipedia.org/w/api.php?action=query&prop=langlinks' +
            '&format=json&lllimit=500&titles=' + article;
        var options = {
          url: languageClusterUrl,
          headers: {
            'User-Agent': USER_AGENT
          }
        };
        // get language references via the Wikipedia API
        article = language + ':' + article;
        request.get(options, function(error, response, body) {
          getLanguageReferences(error, response, body, article);
        });

        // get diff URL
        var diffUrl = messageComponents[0]
            .replace(/.*?\u000302(.*?)\u0003.+$/, '$1');
        if ((diffUrl.indexOf('diff') !== -1) &&
            (diffUrl.indexOf('oldid') !== -1)) {
          var toRev = diffUrl.replace(/.*\?diff=(\d+).*/, '$1');
          var fromRev = diffUrl.replace(/.*&oldid=(\d+).*/, '$1');
          diffUrl = 'http://' + language +
              '.wikipedia.org/w/api.php?action=compare&torev=' + toRev +
              '&fromrev=' + fromRev + '&format=json';
        } else {
          diffUrl = '';
        }
        var delta = messageComponents[2]
            .replace(/\s\(\u0002?([+-]\d+)\u0002?\)\s\x0310.*?$/, '$1')
            .replace(/\u0003/g, '');

        // new article
        if (!articleVersionsMap[article]) {
          now = new Date().getTime();
          articles[article] = {
            title: article,
            timestamp: now,
            occurrences: 1,
            intervals: [],
            editors: [editor],
            languages: {},
            versions: {},
            changes: {}
          };
          articles[article].languages[language] = 1;
          articles[article].changes[now] = {
            diffUrl: diffUrl,
            delta: delta,
            language: language,
            editor: editor
          };
          if (VERBOUS && REALLY_VERBOUS) {
            console.log('[ * ] First time seen: "' + article + '". ' +
                'Timestamp: ' + new Date(articles[article].timestamp) + '. ' +
                'Editors: ' + editor + '. ' +
                'Languages: ' + JSON.stringify(articles[article].languages));
          }
        // existing article
        } else {
          var currentArticle = article;
          now = new Date().getTime();
          if (article !== articleVersionsMap[article]) {
            if (VERBOUS && REALLY_VERBOUS) {
              console.log('[ ⚭ ] Merging ' + article + ' with ' +
                  articleVersionsMap[article]);
            }
            article = articleVersionsMap[article];
          }
          // update statistics of the article
          articles[article].occurrences += 1;
          articles[article].versions[currentArticle] = true;
          articles[article].intervals.push(now - articles[article].timestamp);
          articles[article].timestamp = now;
          articles[article].changes[now] = {
            diffUrl: diffUrl,
            delta: delta,
            language: language,
            editor: editor
          };
          // we track editors by languages like so: lang:user. if the same user
          // edits an article in different languages, she is logged as
          // lang1:user and lang2:user, but we still consider them the same,
          // and add them like so: lang1,lang2:user.
          var editorPresent = false;
          var presentEditorIndex = 0;
          var currentEditor = editor.split(':')[1];
          for (var i = 0, l = articles[article].editors.length; i < l; i++) {
            if (currentEditor === articles[article].editors[i].split(':')[1]) {
              editorPresent = true;
              presentEditorIndex = i;
              break;
            }
          }
          if (!editorPresent) {
            articles[article].editors.push(editor);
          } else {
            var currentLanguages =
                articles[article].editors[presentEditorIndex].split(':')[0];
            if (currentLanguages.indexOf(language) === -1) {
              currentLanguages = language + ',' + currentLanguages;
            }
            articles[article].editors[presentEditorIndex] =
                currentLanguages + ':' + currentEditor;
          }
          if (articles[article].languages[language]) {
            articles[article].languages[language] += 1;
          } else {
            articles[article].languages[language] = 1;
          }
          // check the three breaking news conditions:
          //
          // (1) breaking news threshold
          var breakingNewsThresholdReached =
              articles[article].occurrences >= BREAKING_NEWS_THRESHOLD;
          // (2) check interval distances between edits
          // if something is suspected to be breaking news, all interval
          // distances must be below a certain threshold
          var intervals = articles[article].intervals;
          var allEditsInShortDistances = false;
          var index = 0;
          var intervalsLength = intervals.length;
          if (intervalsLength > BREAKING_NEWS_THRESHOLD - 1) {
            index = intervalsLength - BREAKING_NEWS_THRESHOLD + 1;
          }
          for (var i = index; i < intervalsLength; i++) {
            if (intervals[i] <= SECONDS_BETWEEN_EDITS * 1000) {
              allEditsInShortDistances = true;
            } else {
              allEditsInShortDistances = false;
              break;
            }
          }
          // (3) number of concurrent editors
          var numberOfEditors = articles[article].editors.length;
          var numberOfEditorsReached =
              numberOfEditors >= NUMBER_OF_CONCURRENT_EDITORS;

          // search for all article titles in social networks
          var searchTerms = {};
          searchTerms[article.split(':')[1].replace(/_/g, ' ')] = true;
          for (var key in articles[article].versions) {
            var articleTitle = key.split(':')[1].replace(/_/g, ' ');
            if (!searchTerms[articleTitle]) {
              searchTerms[articleTitle] = true;
            }
          }
          socialNetworkSearch(searchTerms, function(socialNetworksResults) {
            if (VERBOUS) {
              console.log('[ ! ] ' + articles[article].occurrences + ' ' +
                  'times seen: "' + article + '". ' +
                  'Timestamp: ' + new Date(articles[article].timestamp) +
                  '. Edit intervals: ' + articles[article].intervals.toString()
                  .replace(/(\d+),?/g, '$1ms ').trim() + '. ' +
                  'Parallel editors: ' + articles[article].editors.length +
                  '. Editors: ' + articles[article].editors + '. ' +
                  'Languages: ' + JSON.stringify(articles[article].languages));
            }
            var isBreakingNewsCandidate = false;
            if ((breakingNewsThresholdReached) &&
                (allEditsInShortDistances) &&
                (numberOfEditorsReached)) {
              isBreakingNewsCandidate = true;
            }
            getDiffText(diffUrl, articles[article], now,
                isBreakingNewsCandidate, socialNetworksResults, stream);
            // check if all three breaking news conditions are fulfilled at once
            if (isBreakingNewsCandidate) {
              if (VERBOUS) {
                console.log('[ ★ ] Breaking news candidate: "' +
                    article + '". ' +
                    articles[article].occurrences + ' ' +
                    'times seen. ' +
                    'Timestamp: ' + new Date(articles[article].timestamp) +
                    '. Edit intervals: ' +
                    articles[article].intervals.toString()
                    .replace(/(\d+),?/g, '$1ms ').trim() + '. ' +
                    'Number of editors: ' +
                    articles[article].editors.length + '. ' +
                    'Editors: ' + articles[article].editors + '. ' +
                    'Languages: ' +
                    JSON.stringify(articles[article].languages));
              }
            }
          });
        }
      }
    }
  });
}

function getDiffText(diffUrl, article, now, isBreakingNewsCandidate,
    socialNetworksResults, stream) {
  if (diffUrl && article) {
    var options = {
      url: diffUrl,
      headers: {
        'User-Agent': USER_AGENT
      }
    };
    request.get(options, function(error, response, body) {
      if (!error) {
        var json;
        try {
          json = JSON.parse(body);
        } catch(e) {
          json = false;
        }
        if (json && json.compare && json.compare['*']) {
          var parsedHtml = $.load(json.compare['*']);
          var addedLines = parsedHtml('.diff-addedline');
          addedLines.each(function(i, elem) {
            var text = $(this).text();
            var concepts =
                extractWikiConcepts(text, article.changes[now].language);
            if (!text.trim()) {
              return;
            }
            text = removeWikiNoise(text);
            text = removeWikiMarkup(text);
            if (!text.trim()) {
              return;
            }
            article.changes[now].diffText = text;
            article.changes[now].namedEntities = concepts;
            article.isBreakingNewsCandidate = isBreakingNewsCandidate;
            article.socialNetworksResults = socialNetworksResults;
            stream.write(JSON.stringify(article) + '\n');
          });
        }
      }
    });
  }
}

function strip_tags (input, allowed) {
  // http://kevin.vanzonneveld.net
  // +   original by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  // +   improved by: Luke Godfrey
  // +      input by: Pul
  // +   bugfixed by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  // +   bugfixed by: Onno Marsman
  // +      input by: Alex
  // +   bugfixed by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  // +      input by: Marc Palau
  // +   improved by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  // +      input by: Brett Zamir (http://brett-zamir.me)
  // +   bugfixed by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  // +   bugfixed by: Eric Nagel
  // +      input by: Bobby Drake
  // +   bugfixed by: Kevin van Zonneveld (http://kevin.vanzonneveld.net)
  // +   bugfixed by: Tomasz Wesolowski
  // +      input by: Evertjan Garretsen
  // +    revised by: Rafał Kukawski (http://blog.kukawski.pl/)
  // *     example 1: strip_tags('<p>Kevin</p> <br /><b>van</b> <i>Zonneveld</i>', '<i><b>');
  // *     returns 1: 'Kevin <b>van</b> <i>Zonneveld</i>'
  // *     example 2: strip_tags('<p>Kevin <img src="someimage.png" onmouseover="someFunction()">van <i>Zonneveld</i></p>', '<p>');
  // *     returns 2: '<p>Kevin van Zonneveld</p>'
  // *     example 3: strip_tags("<a href='http://kevin.vanzonneveld.net'>Kevin van Zonneveld</a>", "<a>");
  // *     returns 3: '<a href='http://kevin.vanzonneveld.net'>Kevin van Zonneveld</a>'
  // *     example 4: strip_tags('1 < 5 5 > 1');
  // *     returns 4: '1 < 5 5 > 1'
  // *     example 5: strip_tags('1 <br/> 1');
  // *     returns 5: '1  1'
  // *     example 6: strip_tags('1 <br/> 1', '<br>');
  // *     returns 6: '1  1'
  // *     example 7: strip_tags('1 <br/> 1', '<br><br/>');
  // *     returns 7: '1 <br/> 1'
  allowed = (((allowed || "") + "").toLowerCase().match(/<[a-z][a-z0-9]*>/g) || []).join(''); // making sure the allowed arg is a string containing only tags in lowercase (<a><b><c>)
  var tags = /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi,
    commentsAndPhpTags = /<!--[\s\S]*?-->|<\?(?:php)?[\s\S]*?\?>/gi;
  return input.replace(commentsAndPhpTags, '').replace(tags, function ($0, $1) {
    return allowed.indexOf('<' + $1.toLowerCase() + '>') > -1 ? $0 : '';
  });
}

function extractWikiConcepts(text, language) {
  var concepts = [];
  text = text.replace(/\[\[(.*?)\]\]/g, function(m, l) {
    var p = l.split(/\|/);
    var link = p.shift();

    if (link.match(/^Image:(.*)/)) {
      return false;
    }
    if (link.indexOf(':') === -1) {
      concepts.push(language + ':' + link.replace(/\s/g, '_'));
    } else {
      concepts.push(link.replace(/\s/g, '_'));
    }
  });
  return concepts;
}

function removeWikiNoise(text) {
  // remove things like [[Kategorie:Moravske Toplice| Moravske Toplice]]
  var namespaceNoiseRegEx = /\[\[.*?\:.*?\]\]/g;
  // remove things like {{NewZealand-writer-stub}}
  var commentNoiseRegEx = /\{\{.*?\}\}/g;
  // remove things like align="center"
  var htmlAttributeRegEx = /\w+\s*\=\s*\"\w+\"/g;
  // remove things like {{
  var openingCommentParenthesisRegEx = /\{\{/g;
  // remove things like }}
  var closingCommentParenthesisRegEx = /\}\}/g;
  text = text.replace(namespaceNoiseRegEx, '')
      .replace(commentNoiseRegEx, ' ')
      .replace(htmlAttributeRegEx, ' ')
      .replace(openingCommentParenthesisRegEx, ' ')
      .replace(closingCommentParenthesisRegEx, ' ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  text = strip_tags(text);
  return text;
}

function removeWikiMarkup(text) {
  var tableMarkupRegEx = /\|/g;
  text = strip_tags(wiki2html(text));
  text = text.replace(tableMarkupRegEx, ' ')
      .replace(/\[\[/g, ' ')
      .replace(/\]\]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s?=\s?/g, ' = ')
      .trim();
  return text;
}

// callback function for getting language references from the Wikipedia API
// for an article
function getLanguageReferences(error, response, body, article) {
  if (!error && response.statusCode == 200) {
    var json;
    try {
      json = JSON.parse(body);
    } catch(e) {
      json = false;
    }
    if (json && json.query && json.query.pages) {
      var pages = json.query.pages;
      for (id in pages) {
        var page = pages[id];
        if (!articleClusters[article]) {
          articleClusters[article] = {};
        }
        if (page.langlinks) {
          page.langlinks.forEach(function(langLink) {
            var lang = langLink.lang;
            if ((millionPlusLanguages[lang]) ||
                ((MONITOR_LONG_TAIL_WIKIPEDIAS) &&
                    (oneHundredThousandPlusLanguages[lang]))) {
              var title = langLink['*'].replace(/\s/g, '_');
              var articleVersion = lang + ':' + title;
              articleClusters[article][articleVersion] = true;
              articleVersionsMap[articleVersion] = article;
            }
          });
        }
      }
    }
  } else {
    var red = '\u001b[31m';
    var reset = '\u001b[0m';
    console.log(red + new Date() + ' ERROR (Wikipedia API)' + reset +
        (response? ' Status Code: ' + response.statusCode : '') + '.');
  }
}

// start static serving
// and set default route to index.html
app.use(express.static(__dirname + '/static'));
app.get('/', function(req, res) {
  res.sendfile(__dirname + '/index.html');
});

// clean-up function, called regularly like a garbage collector
function cleanUpMonitoringLoop() {
  for (var key in articles) {
    var now = new Date().getTime();
    if (now - articles[key].timestamp > SECONDS_SINCE_LAST_EDIT * 1000) {
      delete articles[key];
      for (version in articleClusters[key]) {
        delete articleVersionsMap[version];
      }
      delete articleClusters[key];
      delete articleVersionsMap[key];
      if (VERBOUS && REALLY_VERBOUS) {
        console.log('[ † ] No more mentions: "' + key + '". ' +
            'Article clusters left: ' +
                Object.keys(articleClusters).length + '. ' +
            'Mappings left: ' + Object.keys(articleVersionsMap).length);
      }
    }
  }
}

// start logging
function getIsoDate(date) {
  var pad = function pad(d) { return d < 10 ? '0' + d : d; };
  return date.getFullYear() + '-' + pad(date.getMonth()) + '-' +
      pad(date.getDate());
}

// start garbage collector
setInterval(function() {
  cleanUpMonitoringLoop();
}, 10 * 1000);

// prepare logging
var fileName = 'log-' + getIsoDate(new Date()) + '.txt';
var stream = fs.createWriteStream(fileName, { flags: 'w' });

// start the monitoring process upon a connection
monitorWikipedia(stream);

// start the server
var port = process.env.PORT || 8080;
server.listen(port);
console.log('Wikipedia Diff Monitor started on port ' + port);
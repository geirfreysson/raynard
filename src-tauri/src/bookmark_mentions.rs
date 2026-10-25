//! Bookmark references in the composer: the slug a bookmark is mentioned by,
//! the candidates the `@` menu offers, and which bookmarks a submitted message
//! refers to.
//!
//! This lives beside the bookmark cache so the renderer never has to hold the
//! whole collection: it asks for a handful of menu candidates as the user types
//! and for the referenced bookmarks once, on send.

use serde::Serialize;

use crate::StoredBookmark;

const SLUG_BASE_MAX_CHARS: usize = 40;
const SLUG_HASH_CHARS: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BookmarkMentionCandidate {
    pub(crate) slug: String,
    pub(crate) label: String,
    pub(crate) chat_name: String,
}

/// The label a bookmark is listed under: its model-written title, or the
/// prompt when there is none. Mirrors `bookmarkLabel` in `src/bookmarks.ts`.
fn bookmark_label(bookmark: &StoredBookmark) -> &str {
    let title = bookmark.title.trim();
    if title.is_empty() {
        &bookmark.prompt
    } else {
        title
    }
}

/// FNV-1a over UTF-16 code units, rendered in base 36. Matches
/// `stableTextHash` in `src/bookmarks.ts`, so slugs users have already seen
/// keep resolving.
fn stable_text_hash(text: &str) -> String {
    let mut hash: u32 = 0x811c9dc5;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    to_base36(hash)
}

fn to_base36(mut value: u32) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if value == 0 {
        return "0".to_string();
    }
    let mut digits = Vec::new();
    while value > 0 {
        digits.push(DIGITS[(value % 36) as usize]);
        value /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).expect("base36 digits are ASCII")
}

fn kebab_case(text: &str) -> String {
    let mut kebab = String::new();
    for char in text.to_lowercase().chars() {
        if char.is_ascii_lowercase() || char.is_ascii_digit() {
            kebab.push(char);
        } else if !kebab.ends_with('-') {
            kebab.push('-');
        }
    }
    let trimmed: String = kebab
        .trim_matches('-')
        .chars()
        .take(SLUG_BASE_MAX_CHARS)
        .collect();
    trimmed.trim_end_matches('-').to_string()
}

/// A stable, unique mention slug: kebab(label) plus a short hash of the id.
/// The hash suffix is what makes a bare slug in a message a deliberate
/// reference rather than a coincidence.
pub(crate) fn bookmark_mention_slug(bookmark: &StoredBookmark) -> String {
    let base = kebab_case(bookmark_label(bookmark));
    let base = if base.is_empty() { "bookmark" } else { &base };
    let hash = stable_text_hash(&bookmark.id);
    let suffix: String = hash.chars().take(SLUG_HASH_CHARS).collect();
    format!("{base}-{suffix}")
}

/// Same character class as `isReferenceTokenChar` in `src/mention.ts`.
fn is_reference_token_char(char: char) -> bool {
    char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '/' | '-')
}

/// Every candidate slug in `text`: each maximal run of reference-token
/// characters, with trailing `.`/`/` trimmed so a slug ending a sentence still
/// matches. A leading `@` is not a token character, so `@slug` and the bare
/// slug the `@` menu inserts both come out as `slug`.
fn reference_tokens(text: &str) -> Vec<&str> {
    text.split(|char: char| !is_reference_token_char(char))
        .map(|token| token.trim_end_matches(['.', '/']))
        .filter(|token| !token.is_empty())
        .collect()
}

/// The bookmarks `text` refers to, in order of first mention, each once.
pub(crate) fn resolve_bookmark_mentions<'a>(
    bookmarks: impl IntoIterator<Item = &'a StoredBookmark>,
    text: &str,
) -> Vec<StoredBookmark> {
    let tokens = reference_tokens(text);
    if tokens.is_empty() {
        return Vec::new();
    }
    let by_slug: std::collections::HashMap<String, &StoredBookmark> = bookmarks
        .into_iter()
        .map(|bookmark| (bookmark_mention_slug(bookmark), bookmark))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut matched = Vec::new();
    for token in tokens {
        if let Some(bookmark) = by_slug.get(token) {
            if seen.insert(bookmark.id.as_str()) {
                matched.push((*bookmark).clone());
            }
        }
    }
    matched
}

/// The best `limit` menu candidates for `query`, ranked like
/// `filterMentionItems` in `src/mention.ts` (label/slug prefix, then match at
/// the start, then anywhere) so the renderer can merge them with plugin items
/// and rank the union without changing the order.
pub(crate) fn search_bookmark_mentions<'a>(
    bookmarks: impl IntoIterator<Item = &'a StoredBookmark>,
    query: &str,
    limit: usize,
) -> Vec<BookmarkMentionCandidate> {
    let query = query.trim().to_lowercase();
    let mut scored = Vec::new();
    for bookmark in bookmarks {
        let slug = bookmark_mention_slug(bookmark);
        let label = bookmark_label(bookmark).to_string();
        let score = if query.is_empty() {
            0
        } else {
            let haystack = format!("{slug} {label}").to_lowercase();
            let Some(index) = haystack.find(&query) else {
                continue;
            };
            if label.to_lowercase().starts_with(&query) || slug.starts_with(&query) {
                0
            } else if index == 0 {
                1
            } else {
                2
            }
        };
        scored.push((
            score,
            BookmarkMentionCandidate {
                slug,
                label,
                chat_name: bookmark.chat_name.clone(),
            },
        ));
        if query.is_empty() && scored.len() == limit {
            break;
        }
    }
    // Stable, so equal scores keep the cache's newest-first order.
    scored.sort_by_key(|(score, _)| *score);
    scored
        .into_iter()
        .take(limit)
        .map(|(_, candidate)| candidate)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bookmark(id: &str, title: &str, prompt: &str) -> StoredBookmark {
        StoredBookmark {
            id: id.to_string(),
            message_key: format!("key-{id}"),
            chat_id: "chat-1".to_string(),
            chat_name: "Research".to_string(),
            title: title.to_string(),
            prompt: prompt.to_string(),
            answer: format!("answer for {id}"),
            message_timestamp: 0,
            created_at: 0,
        }
    }

    // Expected values were produced by the TypeScript implementation this
    // replaced; a slug a user has already seen in the menu must not change.
    #[test]
    fn slug_matches_the_previous_typescript_output() {
        let cases = [
            (bookmark("apple-1", "Apple FY2024 margins", "x"), "apple-fy2024-margins-176azl"),
            (
                bookmark(
                    "bm-mpq7e2-9z",
                    "",
                    "  Autodesk (ADSK) entry/exit limits — what should I do when the price is up 10%?",
                ),
                "autodesk-adsk-entry-exit-limits-what-sho-9ijrpv",
            ),
            (bookmark("é😀-id", "   ", "!!!"), "bookmark-jpbxt5"),
            (bookmark("x", "Ångström Kelvin İstanbul", "p"), "ngstr-m-kelvin-i-stanbul-1y7mkj"),
            (
                bookmark(
                    "chat-mtltwt24-ea0coi1mk36zk:mtnkc9gb-1xgc96t",
                    "Autodesk ADSK entry exit limits",
                    "p",
                ),
                "autodesk-adsk-entry-exit-limits-mpgco1",
            ),
        ];
        for (bookmark, expected) in cases {
            assert_eq!(bookmark_mention_slug(&bookmark), expected);
        }
    }

    fn resolved_ids(bookmarks: &[StoredBookmark], text: &str) -> Vec<String> {
        resolve_bookmark_mentions(bookmarks, text)
            .into_iter()
            .map(|bookmark| bookmark.id)
            .collect()
    }

    #[test]
    fn resolves_an_at_mention_and_the_bare_slug_the_menu_inserts() {
        let bookmarks = [bookmark("apple-1", "Apple FY2024 margins", "x")];
        let slug = bookmark_mention_slug(&bookmarks[0]);
        assert_eq!(
            resolved_ids(&bookmarks, &format!("look at @{slug} now")),
            ["apple-1"]
        );
        assert_eq!(
            resolved_ids(&bookmarks, &format!("if you look at {slug} and the price")),
            ["apple-1"]
        );
    }

    #[test]
    fn resolves_a_slug_followed_by_sentence_punctuation() {
        let bookmarks = [bookmark("apple-1", "Apple FY2024 margins", "x")];
        let slug = bookmark_mention_slug(&bookmarks[0]);
        for text in [
            format!("check {slug}."),
            format!("is {slug}? ok"),
            format!("see {slug}, then"),
        ] {
            assert_eq!(resolved_ids(&bookmarks, &text), ["apple-1"], "{text}");
        }
    }

    #[test]
    fn resolves_each_bookmark_once_in_order_of_first_mention() {
        let bookmarks = [
            bookmark("apple-1", "Apple FY2024 margins", "x"),
            bookmark("apple-2", "Apple FY2024 margins", "y"),
        ];
        let first = bookmark_mention_slug(&bookmarks[0]);
        let second = bookmark_mention_slug(&bookmarks[1]);
        assert_ne!(first, second);
        assert_eq!(
            resolved_ids(&bookmarks, &format!("{second} vs @{first} vs {second}")),
            ["apple-2", "apple-1"]
        );
    }

    #[test]
    fn ignores_tokens_that_only_contain_or_prefix_a_slug() {
        let bookmarks = [bookmark("apple-1", "Apple FY2024 margins", "x")];
        let slug = bookmark_mention_slug(&bookmarks[0]);
        for text in [
            format!("xx-{slug}"),
            format!("{slug}x"),
            slug[..slug.len() - 1].to_string(),
            format!("path/{slug}"),
            "just a plain message".to_string(),
        ] {
            assert!(resolved_ids(&bookmarks, &text).is_empty(), "{text}");
        }
    }

    #[test]
    fn search_ranks_prefix_matches_first_and_caps_the_count() {
        let bookmarks = [
            bookmark("1", "Tesla deliveries", "x"),
            bookmark("2", "Autodesk entry exit", "x"),
            bookmark("3", "Q3 Autodesk notes", "x"),
        ];
        let labels = |query: &str, limit: usize| -> Vec<String> {
            search_bookmark_mentions(&bookmarks, query, limit)
                .into_iter()
                .map(|candidate| candidate.label)
                .collect()
        };
        assert_eq!(
            labels("autodesk", 8),
            ["Autodesk entry exit", "Q3 Autodesk notes"]
        );
        assert_eq!(labels("  ", 2), ["Tesla deliveries", "Autodesk entry exit"]);
        assert!(labels("nothing-like-this", 8).is_empty());
    }

    #[test]
    fn search_candidates_carry_the_slug_and_chat_name() {
        let bookmarks = [bookmark("apple-1", "Apple FY2024 margins", "x")];
        let candidates = search_bookmark_mentions(&bookmarks, "apple", 8);
        assert_eq!(
            candidates,
            [BookmarkMentionCandidate {
                slug: "apple-fy2024-margins-176azl".to_string(),
                label: "Apple FY2024 margins".to_string(),
                chat_name: "Research".to_string(),
            }]
        );
    }
}

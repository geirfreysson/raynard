use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const CONTRIBUTION_REPOSITORY: &str = "https://github.com/geirfreysson/raynard";
const MAX_CONTRIBUTION_FILES: usize = 64;
const MAX_CONTRIBUTION_FILE_BYTES: u64 = 512 * 1024;
const MAX_CONTRIBUTION_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionMetadata {
    pub category: String,
    pub tags: Vec<String>,
    pub icon: String,
    pub author: String,
    pub homepage: String,
}

#[derive(Clone, Debug)]
pub struct ContributionTool {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedExtensionContribution {
    pub folder: String,
    pub extension_folder: String,
    pub patch_path: String,
    pub prompt_path: String,
    pub pr_body_path: String,
    pub title: String,
    pub harness_prompt: String,
    pub pr_body: String,
    pub files: Vec<String>,
    pub checks: Vec<String>,
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn clean_text(value: &str, field: &str, max: usize) -> Result<String, String> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        return Err(format!("{field} is required."));
    }
    if cleaned.chars().count() > max {
        return Err(format!("{field} must be {max} characters or fewer."));
    }
    if cleaned.chars().any(char::is_control) {
        return Err(format!("{field} contains unsupported control characters."));
    }
    Ok(cleaned.to_string())
}

fn clean_slug(value: &str, field: &str) -> Result<String, String> {
    let cleaned = clean_text(value, field, 64)?;
    if cleaned.starts_with('-')
        || cleaned.ends_with('-')
        || cleaned.contains("--")
        || !cleaned.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
    {
        return Err(format!(
            "{field} must use lowercase letters, numbers, and single hyphens."
        ));
    }
    Ok(cleaned)
}

fn clean_https_url(value: &str, field: &str) -> Result<String, String> {
    let cleaned = clean_text(value, field, 500)?;
    if !cleaned.starts_with("https://") || cleaned.chars().any(char::is_whitespace) {
        return Err(format!("{field} must be a plain https:// URL."));
    }
    let host = cleaned
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("");
    if host.is_empty() || !host.contains('.') {
        return Err(format!("{field} must include a valid host."));
    }
    Ok(cleaned)
}

fn normalized_metadata(metadata: ContributionMetadata) -> Result<ContributionMetadata, String> {
    let mut tags = Vec::new();
    for raw in metadata.tags {
        let mut tag = String::new();
        for character in raw.trim().to_ascii_lowercase().chars() {
            if character.is_ascii_alphanumeric() {
                tag.push(character);
            } else if (character == '-' || character == '_' || character.is_whitespace())
                && !tag.ends_with('-')
            {
                tag.push('-');
            }
        }
        let tag = tag.trim_matches('-').to_string();
        if tag.is_empty() || tags.contains(&tag) {
            continue;
        }
        if tag.len() > 40 {
            return Err("Each tag must be 40 characters or fewer.".to_string());
        }
        tags.push(tag);
        if tags.len() == 12 {
            break;
        }
    }
    if tags.is_empty() {
        return Err("At least one tag is required.".to_string());
    }

    Ok(ContributionMetadata {
        category: clean_text(&metadata.category, "Category", 80)?,
        tags,
        icon: clean_slug(&metadata.icon, "Icon")?,
        author: clean_text(&metadata.author, "Author", 120)?,
        homepage: clean_https_url(&metadata.homepage, "Homepage")?,
    })
}

fn is_excluded_name(name: &str) -> bool {
    matches!(
        name,
        ".runtime-tools.json"
            | ".plugin-data"
            | ".git"
            | ".DS_Store"
            | "node_modules"
            | "dist"
            | "build"
            | "coverage"
            | "target"
            | "package-lock.json"
    ) || name == ".env"
        || name.starts_with(".env.")
}

fn is_portable_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_allowed_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if name == "plugin.json" || name == "README.md" {
        return true;
    }
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("ts" | "js" | "mjs" | "json" | "md")
    )
}

fn collect_authored_files(plugin_dir: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        let entries = fs::read_dir(directory)
            .map_err(|error| format!("Could not read {}: {error}", directory.display()))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Could not read extension entry: {error}"))?;
            let path = entry.path();
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| "Extension filenames must be valid UTF-8.".to_string())?;
            if is_excluded_name(name) {
                continue;
            }
            if !is_portable_name(name) {
                return Err(format!(
                    "Contribution paths may use only letters, numbers, dots, underscores, and hyphens: {}",
                    path.display()
                ));
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
            if metadata.file_type().is_symlink() {
                return Err(format!("Symlinks cannot be submitted: {}", path.display()));
            }
            if metadata.is_dir() {
                if name.starts_with('.') {
                    continue;
                }
                visit(root, &path, files)?;
                continue;
            }
            if !metadata.is_file() {
                return Err(format!("Unsupported extension entry: {}", path.display()));
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "Extension file escaped its plugin directory.".to_string())?;
            if relative.components().any(|component| {
                !matches!(component, Component::Normal(_))
                    || component
                        .as_os_str()
                        .to_str()
                        .map(|part| part.starts_with('.'))
                        .unwrap_or(true)
            }) {
                return Err(format!("Unsafe extension path: {}", relative.display()));
            }
            if !is_allowed_file(relative) {
                return Err(format!(
                    "Unsupported contribution file type: {}",
                    relative.display()
                ));
            }
            if metadata.len() > MAX_CONTRIBUTION_FILE_BYTES {
                return Err(format!(
                    "Contribution file is larger than {} KB: {}",
                    MAX_CONTRIBUTION_FILE_BYTES / 1024,
                    relative.display()
                ));
            }
            files.push(relative.to_path_buf());
            if files.len() > MAX_CONTRIBUTION_FILES {
                return Err(format!(
                    "A contribution can contain at most {MAX_CONTRIBUTION_FILES} files."
                ));
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(plugin_dir, plugin_dir, &mut files)?;
    files.sort();
    let total = files.iter().try_fold(0u64, |sum, relative| {
        let size = fs::metadata(plugin_dir.join(relative))
            .map_err(|error| format!("Could not inspect {}: {error}", relative.display()))?
            .len();
        sum.checked_add(size)
            .ok_or_else(|| "Contribution size overflowed.".to_string())
    })?;
    if total > MAX_CONTRIBUTION_BYTES {
        return Err(format!(
            "A contribution can contain at most {} MB of authored files.",
            MAX_CONTRIBUTION_BYTES / 1024 / 1024
        ));
    }
    Ok(files)
}

fn is_test_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    [
        ".test.ts",
        ".test.js",
        ".test.mjs",
        ".spec.ts",
        ".spec.js",
        ".spec.mjs",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
}

pub fn contribution_test_files(plugin_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let tests = collect_authored_files(plugin_dir)?
        .into_iter()
        .filter(|path| is_test_file(path))
        .map(|path| plugin_dir.join(path))
        .collect::<Vec<_>>();
    if tests.is_empty() {
        return Err(
            "A catalog contribution needs at least one executable mocked test.".to_string(),
        );
    }
    Ok(tests)
}

fn required_file(files: &[PathBuf], name: &str) -> Result<(), String> {
    if files.iter().any(|path| path == Path::new(name)) {
        Ok(())
    } else {
        Err(format!("A catalog contribution needs {name}."))
    }
}

fn text_file(path: &Path) -> Result<String, String> {
    let raw =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let text = String::from_utf8(raw)
        .map_err(|_| format!("Contribution files must be UTF-8 text: {}", path.display()))?;
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

fn ensure_final_newline(mut text: String) -> String {
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

fn render_new_file_patch(path: &str, content: &str) -> String {
    let lines = content.lines().collect::<Vec<_>>();
    let mut output = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n",
        lines.len()
    );
    for line in lines {
        output.push('+');
        output.push_str(line);
        output.push('\n');
    }
    output
}

fn unique_output_dir(output_root: &Path, slug: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(output_root)
        .map_err(|error| format!("Could not create contribution directory: {error}"))?;
    for suffix in 0..1000 {
        let stamp = now_millis();
        let name = if suffix == 0 {
            format!("{slug}-{stamp}")
        } else {
            format!("{slug}-{stamp}-{suffix}")
        };
        let path = output_root.join(name);
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create contribution directory: {error}")),
        }
    }
    Err("Could not allocate a unique contribution directory.".to_string())
}

fn manifest_prompts(manifest: &Value) -> Result<(), String> {
    let valid = manifest
        .get("samplePrompts")
        .and_then(Value::as_array)
        .map(|items| {
            items.len() == 3
                && items.iter().all(|item| {
                    item.as_str()
                        .map(str::trim)
                        .is_some_and(|text| !text.is_empty())
                })
        })
        .unwrap_or(false);
    if valid {
        Ok(())
    } else {
        Err("A catalog contribution needs exactly three non-empty sample prompts.".to_string())
    }
}

fn validate_tools(tools: Vec<ContributionTool>) -> Result<Vec<ContributionTool>, String> {
    if tools.is_empty() {
        return Err("Runtime discovery must expose at least one card-backed tool.".to_string());
    }
    let mut names = HashSet::new();
    let mut cleaned = Vec::new();
    for tool in tools {
        let name = clean_text(&tool.name, "Tool name", 120)?;
        let description = clean_text(&tool.description, "Tool description", 1000)?;
        if !names.insert(name.clone()) {
            return Err(format!("Runtime discovery returned duplicate tool: {name}"));
        }
        cleaned.push(ContributionTool { name, description });
    }
    Ok(cleaned)
}

pub fn prepare_extension_contribution_in(
    plugin_dir: &Path,
    output_root: &Path,
    metadata: ContributionMetadata,
    tools: Vec<ContributionTool>,
) -> Result<PreparedExtensionContribution, String> {
    let metadata = normalized_metadata(metadata)?;
    let tools = validate_tools(tools)?;
    let slug = plugin_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Could not determine the extension slug.".to_string())?;
    let slug = clean_slug(slug, "Extension slug")?;
    let files = collect_authored_files(plugin_dir)?;
    for required in ["plugin.json", "tools.ts", "README.md"] {
        required_file(&files, required)?;
    }
    let tests = contribution_test_files(plugin_dir)?;

    let manifest_path = plugin_dir.join("plugin.json");
    let raw_manifest = text_file(&manifest_path)?;
    let mut manifest: Value = serde_json::from_str(&raw_manifest)
        .map_err(|error| format!("Could not parse plugin.json: {error}"))?;
    if manifest.get("sdkVersion").and_then(Value::as_u64) != Some(1) {
        return Err("A catalog contribution must use sdkVersion 1.".to_string());
    }
    manifest_prompts(&manifest)?;

    let readme = text_file(&plugin_dir.join("README.md"))?;
    if !readme.to_ascii_lowercase().contains("endpoint inventory") {
        return Err("README.md must contain an Endpoint Inventory.".to_string());
    }

    let manifest_object = manifest
        .as_object_mut()
        .ok_or_else(|| "plugin.json must contain a JSON object.".to_string())?;
    manifest_object.insert("id".to_string(), json!(format!("raynard.catalog.{slug}")));
    manifest_object.insert("status".to_string(), json!("bundled"));
    manifest_object.insert("category".to_string(), json!(metadata.category));
    manifest_object.insert("tags".to_string(), json!(metadata.tags));
    manifest_object.insert("icon".to_string(), json!(metadata.icon));
    manifest_object.insert("author".to_string(), json!(metadata.author));
    manifest_object.insert("homepage".to_string(), json!(metadata.homepage));
    manifest_object.insert(
        "contributes".to_string(),
        json!({
            "tools": tools
                .iter()
                .map(|tool| json!({
                    "name": tool.name,
                    "description": tool.description,
                    "hasCard": true
                }))
                .collect::<Vec<_>>()
        }),
    );
    let manifest_text = ensure_final_newline(
        serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("Could not serialize catalog manifest: {error}"))?,
    );

    let contribution_dir = unique_output_dir(output_root, &slug)?;
    let extension_dir = contribution_dir.join("extensions").join(&slug);
    fs::create_dir_all(&extension_dir)
        .map_err(|error| format!("Could not create extension bundle: {error}"))?;

    let mut public_files = Vec::new();
    let mut staged_files = Vec::new();
    for relative in files {
        let content = if relative == Path::new("plugin.json") {
            manifest_text.clone()
        } else {
            ensure_final_newline(text_file(&plugin_dir.join(&relative))?)
        };
        let target = extension_dir.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create contribution folder: {error}"))?;
        }
        fs::write(&target, content.as_bytes())
            .map_err(|error| format!("Could not write {}: {error}", target.display()))?;
        let public_path = format!("extensions/{slug}/{}", relative.to_string_lossy());
        public_files.push(public_path.clone());
        staged_files.push((public_path, content));
    }
    public_files.sort();
    staged_files.sort_by(|left, right| left.0.cmp(&right.0));

    let patch = staged_files
        .iter()
        .map(|(path, content)| render_new_file_patch(path, content))
        .collect::<Vec<_>>()
        .join("");
    let patch_path = contribution_dir.join(format!("{slug}.patch"));
    fs::write(&patch_path, patch)
        .map_err(|error| format!("Could not write contribution patch: {error}"))?;

    let title = format!(
        "Add {} extension",
        manifest["name"].as_str().unwrap_or(&slug)
    );
    let tool_list = tools
        .iter()
        .map(|tool| format!("- `{}` — {}", tool.name, tool.description))
        .collect::<Vec<_>>()
        .join("\n");
    let source_list = manifest
        .get("sourceUrls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|source| format!("- {source}"))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "- Declared in the extension README".to_string());
    let pr_body = format!(
        "## Summary\n\nAdds the {} extension to Raynard's bundled catalog.\n\n## Tools\n\n{}\n\n## Source documentation\n\n{}\n\n## Validation\n\n- [x] Local mocked tests passed (`node --test`)\n- [x] Runtime discovery returned {} card-backed tool{}\n- [x] Catalog manifest and Endpoint Inventory validated\n- [x] Machine-local caches and credentials were excluded\n\nPrepared with Raynard.\n",
        manifest["name"].as_str().unwrap_or(&slug),
        tool_list,
        source_list,
        tools.len(),
        if tools.len() == 1 { "" } else { "s" }
    );
    let pr_body_path = contribution_dir.join("PR_BODY.md");
    fs::write(&pr_body_path, &pr_body)
        .map_err(|error| format!("Could not write PR body: {error}"))?;

    let harness_prompt = format!(
        "Contribute the prepared {name} extension to {repository}.\n\nThe validated contribution is in:\n{folder}\n\nAn applyable patch is at:\n{patch}\n\nInstructions:\n1. Inspect the target repository and its worktree before changing anything. Preserve unrelated work.\n2. Start from the current upstream main branch and create a branch named add-extension-{slug}.\n3. Apply the patch, or copy the prepared extensions/{slug}/ folder into the repository.\n4. Verify that only the intended extensions/{slug}/ files are part of this contribution. Never include credentials, .env files, .runtime-tools.json, caches, dependencies, or machine-local files.\n5. Run `npx vitest run scripts/extension-catalog.test.mjs`, then `npm test -- --run` and `npm run build`.\n6. Show me the validation results and complete diff before any commit, push, or pull request.\n7. After I confirm, commit with an imperative message, push using my configured GitHub credentials, and open a pull request using the title and body in this contribution folder.\n\nDo not modify the app-local original plugin.\n",
        name = manifest["name"].as_str().unwrap_or(&slug),
        repository = CONTRIBUTION_REPOSITORY,
        folder = contribution_dir.display(),
        patch = patch_path.display(),
    );
    let prompt_path = contribution_dir.join("HARNESS_PROMPT.md");
    fs::write(&prompt_path, &harness_prompt)
        .map_err(|error| format!("Could not write harness prompt: {error}"))?;

    let checks = vec![
        "Catalog manifest generated without changing the installed plugin.".to_string(),
        "Exactly three sample prompts are present.".to_string(),
        "README Endpoint Inventory is present.".to_string(),
        format!(
            "{} mocked test file{} passed.",
            tests.len(),
            if tests.len() == 1 { "" } else { "s" }
        ),
        format!(
            "Runtime discovery returned {} card-backed tool{}.",
            tools.len(),
            if tools.len() == 1 { "" } else { "s" }
        ),
        format!(
            "{} authored file{} staged; caches and local state excluded.",
            public_files.len(),
            if public_files.len() == 1 { "" } else { "s" }
        ),
    ];
    let validation = json!({
        "pluginId": manifest["id"],
        "repository": CONTRIBUTION_REPOSITORY,
        "title": title,
        "files": public_files,
        "tools": tools.iter().map(|tool| &tool.name).collect::<Vec<_>>(),
        "checks": checks,
    });
    fs::write(
        contribution_dir.join("validation.json"),
        ensure_final_newline(
            serde_json::to_string_pretty(&validation)
                .map_err(|error| format!("Could not serialize validation report: {error}"))?,
        ),
    )
    .map_err(|error| format!("Could not write validation report: {error}"))?;

    Ok(PreparedExtensionContribution {
        folder: contribution_dir.to_string_lossy().to_string(),
        extension_folder: extension_dir.to_string_lossy().to_string(),
        patch_path: patch_path.to_string_lossy().to_string(),
        prompt_path: prompt_path.to_string_lossy().to_string(),
        pr_body_path: pr_body_path.to_string_lossy().to_string(),
        title,
        harness_prompt,
        pr_body,
        files: public_files,
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::{
        fs,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn fixture_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("raynard-contribution-{label}-{stamp}"));
        fs::create_dir_all(&root).expect("fixture root");
        root
    }

    fn write_fixture(plugin_dir: &Path) {
        fs::create_dir_all(plugin_dir).expect("plugin dir");
        fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
  "id": "raynard.generated.eurostat",
  "name": "Eurostat",
  "description": "Query Eurostat data.",
  "version": "0.1.0",
  "sdkVersion": 1,
  "status": "built",
  "createdAt": "2026-08-16T21:37:46.000Z",
  "samplePrompts": ["One", "Two", "Three"],
  "sourceUrls": ["https://ec.europa.eu/eurostat"]
}"#,
        )
        .expect("manifest");
        fs::write(plugin_dir.join("tools.ts"), "export const tools = {};\n").expect("tools");
        fs::write(plugin_dir.join("tools.test.ts"), "// mocked test\n").expect("test");
        fs::write(
            plugin_dir.join("README.md"),
            "# Eurostat\n\n## Endpoint Inventory\n\n| Endpoint | Status |\n| --- | --- |\n",
        )
        .expect("readme");
        fs::write(
            plugin_dir.join(".runtime-tools.json"),
            "{\"source_mtime\":123}",
        )
        .expect("cache");
    }

    fn metadata() -> ContributionMetadata {
        ContributionMetadata {
            category: "Statistics".to_string(),
            tags: vec!["europe".to_string(), "statistics".to_string()],
            icon: "chart-no-axes-combined".to_string(),
            author: "octocat".to_string(),
            homepage: "https://ec.europa.eu/eurostat".to_string(),
        }
    }

    fn tools() -> Vec<ContributionTool> {
        vec![ContributionTool {
            name: "eurostat_query_data".to_string(),
            description: "Query labelled observations.".to_string(),
        }]
    }

    #[test]
    fn prepares_a_catalog_bundle_without_cache_or_local_mutation() {
        let root = fixture_root("bundle");
        let plugin_dir = root.join("generated-plugins/eurostat");
        let output_root = root.join("contributions");
        write_fixture(&plugin_dir);
        let original = fs::read_to_string(plugin_dir.join("plugin.json")).expect("original");

        let prepared =
            prepare_extension_contribution_in(&plugin_dir, &output_root, metadata(), tools())
                .expect("prepare contribution");

        assert_eq!(
            fs::read_to_string(plugin_dir.join("plugin.json")).expect("local manifest"),
            original
        );
        assert!(!Path::new(&prepared.extension_folder)
            .join(".runtime-tools.json")
            .exists());
        let manifest: Value = serde_json::from_str(
            &fs::read_to_string(Path::new(&prepared.extension_folder).join("plugin.json"))
                .expect("catalog manifest"),
        )
        .expect("parse catalog manifest");
        assert_eq!(manifest["id"], "raynard.catalog.eurostat");
        assert_eq!(manifest["status"], "bundled");
        assert_eq!(
            manifest["contributes"]["tools"][0]["name"],
            "eurostat_query_data"
        );
        assert!(fs::read_to_string(&prepared.patch_path)
            .expect("patch")
            .contains("+++ b/extensions/eurostat/tools.ts"));
        assert!(prepared.harness_prompt.contains("npm test -- --run"));
        assert!(prepared.pr_body.contains("eurostat_query_data"));

        let target_repo = root.join("target-repo");
        fs::create_dir_all(&target_repo).expect("target repo");
        assert!(Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&target_repo)
            .status()
            .expect("git init")
            .success());
        assert!(Command::new("git")
            .args(["apply", "--check"])
            .arg(&prepared.patch_path)
            .current_dir(&target_repo)
            .status()
            .expect("git apply check")
            .success());
        assert!(Command::new("git")
            .arg("apply")
            .arg(&prepared.patch_path)
            .current_dir(&target_repo)
            .status()
            .expect("git apply")
            .success());
        assert!(target_repo.join("extensions/eurostat/tools.ts").is_file());

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn finds_mocked_tests_and_rejects_plugins_without_them() {
        let root = fixture_root("tests");
        let plugin_dir = root.join("eurostat");
        write_fixture(&plugin_dir);
        assert_eq!(
            contribution_test_files(&plugin_dir).expect("tests").len(),
            1
        );
        fs::remove_file(plugin_dir.join("tools.test.ts")).expect("remove test");
        assert!(contribution_test_files(&plugin_dir)
            .expect_err("missing tests")
            .contains("mocked test"));
        fs::write(plugin_dir.join("unsafe file.ts"), "export {};\n").expect("unsafe file");
        assert!(collect_authored_files(&plugin_dir)
            .expect_err("unsafe filename")
            .contains("letters, numbers"));
        fs::remove_dir_all(root).expect("cleanup");
    }
}

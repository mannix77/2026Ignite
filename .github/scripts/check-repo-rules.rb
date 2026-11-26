# Checks three rules from CLAUDE.md ("What must not break") that a reviewer used to be the only
# guard for. Run from anywhere in the repository: ruby .github/scripts/check-repo-rules.rb
#
# 1. Only pages.yml deploys to GitHub Pages, and its site holds exactly
#    ios/AppStore/support.html and ios/AppStore/privacy.html, at those paths.
# 2. Every action a workflow or a local action uses is pinned to a full commit SHA.
# 3. No Apple signing team id is written into a tracked file.
#
# The checks are strict on purpose: a workflow shape they can't reproduce is refused with a message,
# never waved through. Exits non-zero, naming each broken rule, if any check fails.

require "yaml"
require "tmpdir"
require "fileutils"
require "open3"
require "find"

ROOT = Dir.chdir(__dir__) { `git rev-parse --show-toplevel`.strip }
abort "Not inside a git repository." if ROOT.empty?
Dir.chdir(ROOT)

failures = []

# The files git tracks, as they are in the working tree (so a local run sees uncommitted edits).
# Symlinks are kept as links, so the Pages replay sees them as the real checkout would.
tracked = `git ls-files -z`.split("\0").select { |path| File.symlink?(path) || File.file?(path) }

def load_yaml(path, failures)
  YAML.safe_load(File.read(path), aliases: true)
rescue Psych::Exception => e
  failures << "YAML: #{path} could not be read: #{e.message}"
  nil
end

workflows = tracked.grep(%r{\A\.github/workflows/[^/]+\.ya?ml\z}).sort
local_actions = tracked.grep(%r{\A(?:.+/)?action\.ya?ml\z}).sort

# --- 1. The Pages site holds exactly the two App Store pages --------------------------------------

PAGES = ".github/workflows/pages.yml"
PUBLISHED = ["ios/AppStore/privacy.html", "ios/AppStore/support.html"].freeze
# The actions the Pages build job may use; any other action could put files in the site unseen.
BUILD_ACTIONS = %w[actions/checkout actions/configure-pages actions/upload-pages-artifact].freeze
# Step keys the check can reproduce: shell steps it replays, and action steps it reads.
RUN_STEP_KEYS = %w[name id run].freeze
ACTION_STEP_KEYS = %w[name id uses with].freeze
PAGES_ACTIONS = %w[actions/upload-pages-artifact actions/deploy-pages].freeze

def action_name(ref)
  ref.to_s.split("@").first
end

def jobs_of(workflow)
  jobs = workflow.is_a?(Hash) ? workflow["jobs"] : nil
  jobs.is_a?(Hash) ? jobs : {}
end

# Only pages.yml may upload or deploy a Pages site: its build job uploads, its deploy job deploys.
workflows.each do |path|
  workflow = load_yaml(path, failures) or next
  jobs_of(workflow).each do |job_name, job|
    Array(job.is_a?(Hash) ? job["steps"] : nil).each do |step|
      name = action_name(step.is_a?(Hash) ? step["uses"] : nil)
      allowed =
        case name
        when "actions/upload-pages-artifact" then path == PAGES && job_name == "build"
        when "actions/deploy-pages" then path == PAGES && job_name == "deploy"
        else true
        end
      failures << "Pages: #{path} job #{job_name} uses #{name}; only pages.yml publishes the site" unless allowed
    end
  end
end

# A local composite action runs its steps wherever it is called, so it may not wrap a Pages action.
local_actions.each do |path|
  document = load_yaml(path, failures) or next
  runs = document.is_a?(Hash) ? document["runs"] : nil
  Array(runs.is_a?(Hash) ? runs["steps"] : nil).grep(Hash).each do |step|
    name = action_name(step["uses"])
    failures << "Pages: #{path} uses #{name}; only pages.yml publishes the site" if PAGES_ACTIONS.include?(name)
  end
end

def pages_site_files(tracked, failures)
  workflow = load_yaml(PAGES, failures) or return nil
  build = jobs_of(workflow)["build"]
  steps = build.is_a?(Hash) ? build["steps"] : nil
  return "pages.yml has no build job steps" unless steps.is_a?(Array) && steps.all? { |s| s.is_a?(Hash) }
  %w[defaults env].each do |key|
    return "pages.yml sets #{key} for the whole workflow, which this check can't reproduce" if workflow.key?(key)
    return "the build job sets #{key}, which this check can't reproduce" if build.key?(key)
  end

  uploads = steps.select { |s| action_name(s["uses"]) == "actions/upload-pages-artifact" }
  return "pages.yml must upload exactly one Pages artifact, found #{uploads.size}" unless uploads.size == 1
  # The site is checked as it stands after the last step, so nothing may run after the upload.
  return "the Pages upload must be the build job's last step" unless steps.last.equal?(uploads.first)
  inputs = uploads.first["with"].is_a?(Hash) ? uploads.first["with"] : {}
  site = inputs.key?("path") ? inputs["path"].to_s : "_site/" # the action's own default

  steps.each do |step|
    if step["uses"]
      name = action_name(step["uses"])
      return "the build job uses #{name}; only #{BUILD_ACTIONS.join(", ")} are allowed" unless BUILD_ACTIONS.include?(name)
      extra = step.keys - ACTION_STEP_KEYS
      return "build step #{name} sets #{extra.join(", ")}, which this check can't reproduce" unless extra.empty?
    else
      extra = step.keys - RUN_STEP_KEYS
      return "build step #{step["name"].inspect} sets #{extra.join(", ")}, which this check can't reproduce" unless extra.empty?
      return "build step #{step["name"].inspect} uses a ${{ }} expression, which this check can't reproduce" if step["run"].to_s.include?("${{")
    end
  end

  # Snapshot the two pages before any step runs: a replayed step could change files anywhere, the
  # checkout included, so the expected bytes are fixed now. A page that is itself a symlink could
  # serve anything, so it is refused.
  linked = PUBLISHED.select { |p| File.symlink?(p) }
  return "the published pages must be real files, not symlinks: #{linked.join(", ")}" unless linked.empty?
  missing = PUBLISHED.reject { |p| File.file?(p) }
  return "the published pages are missing from the repository: #{missing.join(", ")}" unless missing.empty?
  expected = PUBLISHED.map { |p| [p, File.binread(p)] }.to_h.freeze

  # Run the build job's shell steps, in order, in a scratch copy of the tracked files, then list
  # what landed in the site directory.
  Dir.mktmpdir do |dir|
    site_dir = File.expand_path(site, dir)
    return "the Pages artifact path #{site.inspect} must be a directory inside the repository" unless site_dir.start_with?("#{dir}/")

    tracked.each do |path|
      FileUtils.mkdir_p(File.join(dir, File.dirname(path)))
      if File.symlink?(path)
        File.symlink(File.readlink(path), File.join(dir, path))
      else
        FileUtils.cp(path, File.join(dir, path))
      end
    end
    env = { "GITHUB_WORKSPACE" => dir, "RUNNER_TEMP" => Dir.mktmpdir }
    steps.each do |step|
      next unless step["run"]
      out, status = Open3.capture2e(env, "bash", "-euo", "pipefail", "-c", step["run"], chdir: dir)
      return "build step #{(step["name"] || step["run"]).inspect} failed:\n#{out}" unless status.success?
    end
    return "the build job leaves nothing at #{site.inspect}" unless File.directory?(site_dir)

    # upload-pages-artifact follows symlinks when it packs the site, so a link could publish
    # anything; refuse them outright rather than guess where they lead.
    files = []
    Find.find(site_dir) do |entry|
      relative = entry.delete_prefix("#{site_dir}/")
      return "the site holds a symlink, #{relative}; copy files in instead" if File.symlink?(entry)
      files << relative if File.file?(entry)
    end
    files.sort!
    # Each address must serve its own page, not the other one's: compare with the snapshot taken
    # before the replay, not with any file a step could have changed.
    if files == PUBLISHED
      swapped = PUBLISHED.reject { |p| File.binread(File.join(site_dir, p)) == expected[p] }
      return "the site's #{swapped.join(" and ")} differ from the repository's; copy each page to its own address" unless swapped.empty?
    end
    files
  end
end

result = pages_site_files(tracked, failures)
if result.is_a?(String)
  failures << "Pages: #{result}"
elsif result && result != PUBLISHED
  failures << "Pages: the site must hold exactly #{PUBLISHED.join(" and ")}; pages.yml builds #{result.inspect}"
end

# --- 2. Every action is pinned to a commit SHA ----------------------------------------------------

PINNED = %r{\A(?:\./.*|docker://.+@sha256:\h{64}|[^@\s]+@\h{40})\z}

def action_refs(document, local_action)
  steps =
    if local_action
      runs = document.is_a?(Hash) ? document["runs"] : nil
      runs.is_a?(Hash) ? Array(runs["steps"]) : []
    else
      jobs_of(document).values.grep(Hash).flat_map do |job|
        [job] + Array(job["steps"]) # a job-level uses: is a reusable workflow
      end
    end
  steps.grep(Hash).map { |s| s["uses"] }.grep(String)
end

(workflows.map { |p| [p, false] } + local_actions.map { |p| [p, true] }).each do |path, local_action|
  document = load_yaml(path, failures) or next
  action_refs(document, local_action).each do |ref|
    failures << "Pinning: #{path} uses #{ref}; pin it to a full commit SHA" unless ref.match?(PINNED)
  end
end

# --- 3. No signing team id in the repository ------------------------------------------------------

# A team id is ten capital letters or digits. Xcode writes one into the project as a build setting
# (plain or per-SDK) and under TargetAttributes; plists, entitlements, JSON and shell scripts name it
# under the keys below. The documented placeholder is allowed.
TEAM_KEY = /(?:DEVELOPMENT_TEAM(?:\[[^\]\n]*\])?|DevelopmentTeam|teamID|team-identifier|\bTEAM)/
TEAM_ID = /(?!ABCDE12345\b)[A-Z0-9]{10}\b/
TEAM_PATTERNS = [
  /#{TEAM_KEY}["']?[ \t]*[=:][ \t]*["']?#{TEAM_ID}/,         # KEY = ID, "KEY": "ID", KEY=ID
  # XML plist or entitlements; XML comments may sit between the key and its value.
  %r{<key>\s*[\w.-]*?#{TEAM_KEY}\s*</key>(?:\s|<!--.*?-->)*<string>\s*(?:<!\[CDATA\[\s*)?#{TEAM_ID}}m,
  /\$\{TEAM:?-["']?#{TEAM_ID}/                               # a shell default, ${TEAM:-ID}
].freeze

def readable_text(path)
  bytes = File.binread(path)
  return [nil, "a binary plist, which can't be checked; commit it as XML"] if bytes.start_with?("bplist")
  if bytes.start_with?("\xFF\xFE".b) || bytes.start_with?("\xFE\xFF".b)
    encoding = bytes.start_with?("\xFF\xFE".b) ? "UTF-16LE" : "UTF-16BE"
    return [bytes.byteslice(2..-1).force_encoding(encoding).encode("UTF-8", invalid: :replace, undef: :replace), nil]
  end
  # Everything else is matched byte for byte, binary files included: the patterns are plain ASCII.
  [bytes, nil]
end

# An XML plist is also read with a parser, so a value split by a comment, CDATA or a character
# reference (<string>ZZZZZ<!-- -->99999</string>) is seen as the parser sees it.
PLIST_TEAM_KEY = /\A\s*[\w.-]*?#{TEAM_KEY}\s*\z/
PLIST_TEAM_VALUE = /\A\s*#{TEAM_ID}\s*\z/
# Any file that starts with markup is parsed, whatever its prolog (declaration, processing
# instructions, comments, doctype), and every <dict> in it is checked. One that can't be parsed is
# refused only if it holds plist markup; an HTML page, say, is left to the byte scan.
XML_START = /\A(?:\xEF\xBB\xBF)?\s*</n
PLIST_MARKUP = /<(?:plist|dict)[\s>\/]/n

def plist_team_keys(text)
  require "rexml/document"
  document = REXML::Document.new(text.dup.force_encoding("UTF-8"))
  found = []
  REXML::XPath.each(document, "//dict") do |dict|
    children = dict.elements.to_a
    children.each_with_index do |child, i|
      next unless child.name == "key" && child.texts.map(&:value).join.match?(PLIST_TEAM_KEY)
      value = children[i + 1] or next
      strings = value.name == "array" ? value.elements.to_a : [value]
      found << child.texts.map(&:value).join.strip if strings.any? { |s| s.texts.map(&:value).join.match?(PLIST_TEAM_VALUE) }
    end
  end
  [found, nil]
rescue REXML::ParseException => e
  [[], e.message.lines.first.to_s.strip]
end

tracked.each do |path|
  next if File.symlink?(path) # its target, if tracked, is scanned in its own right
  text, problem = readable_text(path)
  next failures << "Signing team: #{path} is #{problem}" if problem
  TEAM_PATTERNS.each do |pattern|
    next unless (match = text.match(pattern))
    line = text.byteslice(0, match.pre_match.bytesize).count("\n") + 1
    failures << "Signing team: #{path}:#{line} names a team id; pass it on the command line (TEAM=...) instead"
  end
  next unless text.b.match?(XML_START)
  keys, error = plist_team_keys(text)
  if error && text.b.match?(PLIST_MARKUP)
    failures << "Signing team: #{path} is a plist that can't be parsed, so it can't be checked: #{error}"
  end
  keys.uniq.each do |key|
    failures << "Signing team: #{path} names a team id under #{key}; pass it on the command line (TEAM=...) instead"
  end
end

if failures.empty?
  puts "Repository rules: all three checks pass."
else
  warn failures.uniq.map { |f| "FAIL #{f}" }.join("\n")
  exit 1
end

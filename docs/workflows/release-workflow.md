# Release Workflow

> Reusable end-to-end workflow used for every DreamGraph release. It coordinates repository-wide version alignment, documentation refresh, artifact packaging, release note preparation, source control publication, GitHub release creation, and updates to the related ../dreamgraph-website/ repository.

**Trigger:** A new DreamGraph version is ready to publish and the release owner starts the release pass.  

## Steps

### 1. Align all versions

Update and verify every release-bearing version value across the daemon, dashboard, CLI, architect surface, VS Code extension, package manifests, generated metadata, and any other component participating in the release.

### 2. Update documentation

Refresh the user guide, root README, and any changed documentation. Export the live docs and update documentation artifacts where needed so packaged and published docs match the release.

### 3. Package release artifacts

Build and package all release artifacts for the daemon, dashboard, CLI, architect, VS Code extension, documentation exports, and any other distribution outputs required by the release.

### 4. Write release notes

Prepare release notes that summarize user-facing changes, fixes, operational notes, upgrade guidance, and artifact/version references for the release.

### 5. Commit, tag, and push

Commit the release changes, create the release tag, and push the commit and tag to the authoritative remote.

### 6. Create the GitHub release

Create the GitHub release from the pushed tag, attach or reference the packaged artifacts, and publish the release notes.

### 7. Update related website

Update the related ../dreamgraph-website/ repository so the website reflects the new release, documentation exports, release notes, downloads, and any changed public messaging.


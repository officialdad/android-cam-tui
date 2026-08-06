# Packaging

`PKGBUILD` builds the AUR package `android-cam-tui-bin` from the published
release tarballs. It is bumped by hand at release time — there is no CI push to
the AUR.

To release a new version:

1. Tag and let `.github/workflows/release.yml` publish the assets.
2. Set `pkgver`, reset `pkgrel=1`.
3. Replace all three `sha256sums*` entries — the two release `.sha256` files and
   `sha256sum LICENSE`.
4. `makepkg --printsrcinfo > .SRCINFO`, then push to the AUR repo.

#!/bin/sh
set -eu

release_base="https://github.com/geirfreysson/raynard/releases/latest/download"
asset_name="Raynard-linux-x86_64.AppImage"
checksum_name="${asset_name}.sha256"

if [ "$(uname -s)" != "Linux" ]; then
  echo "This installer supports Linux. Use install.ps1 on Windows or the DMG on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) ;;
  *)
    echo "Raynard currently supports x86_64 Linux only." >&2
    exit 1
    ;;
esac

command -v curl >/dev/null 2>&1 || {
  echo "curl is required to install Raynard." >&2
  exit 1
}

install_root="${XDG_DATA_HOME:-$HOME/.local/share}/raynard"
bin_root="$HOME/.local/bin"
applications_root="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
icons_root="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
app_path="$install_root/Raynard.AppImage"
temp_root="$(mktemp -d)"
trap 'rm -rf "$temp_root"' EXIT INT TERM

curl -fsSL "$release_base/$asset_name" -o "$temp_root/$asset_name"
curl -fsSL "$release_base/$checksum_name" -o "$temp_root/$checksum_name"

expected_checksum="$(awk 'NR == 1 { print $1 }' "$temp_root/$checksum_name")"
if command -v sha256sum >/dev/null 2>&1; then
  actual_checksum="$(sha256sum "$temp_root/$asset_name" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual_checksum="$(shasum -a 256 "$temp_root/$asset_name" | awk '{ print $1 }')"
else
  echo "sha256sum or shasum is required to verify the Raynard download." >&2
  exit 1
fi

if [ -z "$expected_checksum" ] || [ "$actual_checksum" != "$expected_checksum" ]; then
  echo "Raynard download checksum verification failed." >&2
  exit 1
fi

mkdir -p "$install_root" "$bin_root" "$applications_root" "$icons_root"
chmod 755 "$temp_root/$asset_name"
mv "$temp_root/$asset_name" "$app_path"
ln -sf "$app_path" "$bin_root/raynard"

extract_root="$temp_root/icon"
mkdir -p "$extract_root"
if (cd "$extract_root" && "$app_path" --appimage-extract >/dev/null 2>&1); then
  icon_path="$(find "$extract_root/squashfs-root" -type f -path '*256x256*' -name '*.png' -print 2>/dev/null | head -n 1)"
  if [ -z "$icon_path" ]; then
    icon_path="$(find "$extract_root/squashfs-root" -type f -name '*.png' -print 2>/dev/null | head -n 1)"
  fi
  if [ -n "$icon_path" ]; then
    cp "$icon_path" "$icons_root/raynard.png"
  fi
fi

cat >"$applications_root/raynard.desktop" <<EOF
[Desktop Entry]
Name=Raynard
Comment=Desktop AI agent that builds the tools it needs
Exec=$app_path %u
Icon=raynard
Terminal=false
Type=Application
Categories=Utility;
MimeType=x-scheme-handler/raynard;
StartupWMClass=Raynard
X-AppImage-Version=latest
EOF
chmod 644 "$applications_root/raynard.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications_root" >/dev/null 2>&1 || true
fi

case ":$PATH:" in
  *":$bin_root:"*) ;;
  *) echo "Installed. Add $bin_root to PATH to launch Raynard as 'raynard'." ;;
esac

echo "Raynard was installed at $app_path."
"$app_path" >/dev/null 2>&1 &

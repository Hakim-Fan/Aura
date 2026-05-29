#!/bin/bash
set -e

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

CURRENT_BRANCH=$(git -C "$SCRIPT_DIR" branch --show-current 2>/dev/null || echo "")
RELEASE_BRANCH="${RELEASE_BRANCH:-${CURRENT_BRANCH:-master}}"
RELEASE_REMOTE="${RELEASE_REMOTE:-git@github.com:Hakim-Fan/Aura.git}"

# 从 tauri.conf.json 读取当前版本号
CURRENT_VERSION=$(grep '"version"' "$SCRIPT_DIR/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": *"\(.*\)".*/\1/')

# 版本号递增函数
bump_version() {
  local version=$1 part=$2
  IFS='.' read -r major minor patch <<< "$version"
  case $part in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "${major}.$((minor + 1)).0" ;;
    patch) echo "${major}.${minor}.$((patch + 1))" ;;
  esac
}

# 替换所有版本号
update_version() {
  local old=$1 new=$2

  echo -e "${YELLOW}→ 更新版本号: ${old} → ${new}${NC}"

  # tauri.conf.json
  sed -i '' "s/\"version\": \"${old}\"/\"version\": \"${new}\"/" "$SCRIPT_DIR/src-tauri/tauri.conf.json"
  echo -e "  ${GREEN}✓${NC} src-tauri/tauri.conf.json"

  # package.json (只替换第一个匹配)
  sed -i '' "0,/\"version\": \"${old}\"/s/\"version\": \"${old}\"/\"version\": \"${new}\"/" "$SCRIPT_DIR/package.json"
  echo -e "  ${GREEN}✓${NC} package.json"

  # Cargo.toml
  sed -i '' "s/^version = \"${old}\"/version = \"${new}\"/" "$SCRIPT_DIR/src-tauri/Cargo.toml"
  echo -e "  ${GREEN}✓${NC} src-tauri/Cargo.toml"

  # bridge/mcp.mjs
  sed -i '' "s/version: '${old}'/version: '${new}'/" "$SCRIPT_DIR/bridge/mcp.mjs"
  echo -e "  ${GREEN}✓${NC} bridge/mcp.mjs"

  # bridge/mcpActions.mjs
  sed -i '' "s/version: '${old}'/version: '${new}'/" "$SCRIPT_DIR/bridge/mcpActions.mjs"
  echo -e "  ${GREEN}✓${NC} bridge/mcpActions.mjs"

  # 更新 Cargo.lock
  (cd "$SCRIPT_DIR/src-tauri" && cargo generate-lockfile 2>/dev/null) || true
  echo -e "  ${GREEN}✓${NC} src-tauri/Cargo.lock (自动更新)"
}

echo -e "${GREEN}🚀 Aura Release Script${NC}"
echo -e "   当前版本: ${CYAN}${CURRENT_VERSION}${NC}"
echo -e "   发布仓库: ${CYAN}${RELEASE_REMOTE}${NC}"
echo -e "   发布分支: ${CYAN}${RELEASE_BRANCH}${NC}"
echo ""

# 选择操作
echo "请选择操作:"
echo -e "  ${CYAN}1${NC}) patch  升级 → $(bump_version "$CURRENT_VERSION" patch)"
echo -e "  ${CYAN}2${NC}) minor  升级 → $(bump_version "$CURRENT_VERSION" minor)"
echo -e "  ${CYAN}3${NC}) major  升级 → $(bump_version "$CURRENT_VERSION" major)"
echo -e "  ${CYAN}4${NC}) 使用当前版本 ${CURRENT_VERSION} 直接发布"
echo -e "  ${CYAN}5${NC}) 自定义版本号"
echo ""
read -rp "选择 [1-5]: " CHOICE

case $CHOICE in
  1) NEW_VERSION=$(bump_version "$CURRENT_VERSION" patch) ;;
  2) NEW_VERSION=$(bump_version "$CURRENT_VERSION" minor) ;;
  3) NEW_VERSION=$(bump_version "$CURRENT_VERSION" major) ;;
  4) NEW_VERSION="$CURRENT_VERSION" ;;
  5)
    read -rp "输入版本号 (如 1.2.3): " NEW_VERSION
    if ! echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo -e "${RED}✗ 版本号格式错误，应为 x.y.z${NC}"
      exit 1
    fi
    ;;
  *) echo -e "${RED}✗ 无效选择${NC}"; exit 1 ;;
esac

TAG="v${NEW_VERSION}"
echo ""

# 如果版本号有变化，先更新
if [ "$NEW_VERSION" != "$CURRENT_VERSION" ]; then
  update_version "$CURRENT_VERSION" "$NEW_VERSION"
  echo ""
fi

# 读取更新日志
NOTES_FILE="$SCRIPT_DIR/RELEASE_NOTES.md"
if [ ! -s "$NOTES_FILE" ]; then
  echo -e "${RED}✗ RELEASE_NOTES.md 为空或不存在，请先编辑该文件${NC}"
  exit 1
fi

echo -e "${GREEN}✓ 更新日志:${NC}"
echo -e "${CYAN}$(cat "$NOTES_FILE")${NC}"
echo ""

# 提交所有变更（如果有）
if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain)" ]; then
  echo -e "${YELLOW}→ 提交变更...${NC}"
  git -C "$SCRIPT_DIR" add -A
  git -C "$SCRIPT_DIR" commit -m "chore: release ${TAG}"
else
  echo -e "${GREEN}✓ 无需提交，工作区已是最新${NC}"
fi

# 检查工作区是否干净
if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain)" ]; then
  echo -e "${RED}✗ 工作区有未提交的更改，请先提交${NC}"
  git -C "$SCRIPT_DIR" status --short
  exit 1
fi

# 检查 tag 是否已存在
if git -C "$SCRIPT_DIR" tag -l "$TAG" | grep -q "$TAG"; then
  echo -e "${YELLOW}⚠ Tag ${TAG} 已存在，是否删除并重新创建？(y/N)${NC}"
  read -r CONFIRM
  if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
    git -C "$SCRIPT_DIR" tag -d "$TAG"
    git -C "$SCRIPT_DIR" push "$RELEASE_REMOTE" --delete "$TAG" 2>/dev/null || true
    echo -e "${GREEN}✓ 已删除旧 tag${NC}"
  else
    echo "已取消"
    exit 0
  fi
fi

# 推送代码到 GitHub
echo -e "${YELLOW}→ 推送代码到 GitHub...${NC}"
git -C "$SCRIPT_DIR" push "$RELEASE_REMOTE" "HEAD:${RELEASE_BRANCH}"

# 创建并推送 tag
echo -e "${YELLOW}→ 创建 tag ${TAG}...${NC}"
git -C "$SCRIPT_DIR" tag "$TAG"

echo -e "${YELLOW}→ 推送 tag 到 GitHub 触发打包...${NC}"
git -C "$SCRIPT_DIR" push "$RELEASE_REMOTE" "$TAG"

echo ""
echo -e "${GREEN}✅ 完成！版本 ${TAG} 打包流程已触发${NC}"
echo -e "   查看进度: https://github.com/Hakim-Fan/Aura/actions"
echo -e "   发布页面: https://github.com/Hakim-Fan/Aura/releases"

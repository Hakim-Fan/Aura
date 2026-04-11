#!/bin/bash

# Aura 发布脚本
# 使用方法: ./scripts/release.sh <版本号>
# 示例: ./scripts/release.sh v0.1.0

VERSION=$1

if [ -z "$VERSION" ]; then
    echo "❌ 请提供版本号"
    echo "用法: ./scripts/release.sh v0.1.0"
    exit 1
fi

echo "🚀 发布 Aura $VERSION"
echo "===================="

# 1. 确保代码最新
echo ""
echo "📥 确保代码最新..."
git pull origin main

# 2. 推送到 Gitee（备份代码）
echo ""
echo "☁️  推送到 Gitee (代码备份)..."
git push origin main
if [ $? -ne 0 ]; then
    echo "❌ 推送到 Gitee 失败"
    exit 1
fi

# 3. 推送到 GitHub（准备打包）
echo ""
echo "☁️  推送到 GitHub (准备打包)..."
git push github main
if [ $? -ne 0 ]; then
    echo "❌ 推送到 GitHub 失败"
    exit 1
fi

# 4. 创建并推送标签（触发 GitHub Actions 打包）
echo ""
echo "🏷️  创建版本标签 $VERSION..."
git tag $VERSION
git push github $VERSION
if [ $? -ne 0 ]; then
    echo "❌ 推送标签失败"
    exit 1
fi

echo ""
echo "✅ 版本 $VERSION 发布成功!"
echo ""
echo "📦 打包进度查看:"
echo "   https://github.com/Hakim_Fan/desk-agent/actions"
echo ""
echo "⏱️  预计 10-15 分钟后可在 Releases 页面下载安装包"
echo "   https://github.com/Hakim_Fan/desk-agent/releases"
echo ""

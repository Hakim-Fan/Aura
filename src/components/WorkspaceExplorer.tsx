import type { WorkspaceNode } from '../types'

type Props = {
  rootPath: string
  tree: WorkspaceNode | null
  loading: boolean
  error: string
  selectedFilePath: string | null
  previewContent: string
  previewLoading: boolean
  previewError: string
  expandedPaths: string[]
  onRefresh: () => void
  onChooseWorkspace: () => void
  onToggle: (path: string) => void
  onSelectFile: (path: string) => void
  onInsertReference: (path: string) => void
  onCopyPath: (path: string) => void
}

type TreeNodeProps = {
  node: WorkspaceNode
  depth: number
  expandedPaths: string[]
  selectedFilePath: string | null
  onToggle: (path: string) => void
  onSelectFile: (path: string) => void
}

function TreeNode({
  node,
  depth,
  expandedPaths,
  selectedFilePath,
  onToggle,
  onSelectFile,
}: TreeNodeProps) {
  const isDirectory = node.kind === 'directory'
  const isExpanded = expandedPaths.includes(node.path)
  const isSelected = selectedFilePath === node.path

  return (
    <div className="workspace-node">
      <button
        className={
          isSelected
            ? 'workspace-node-button selected'
            : 'workspace-node-button'
        }
        onClick={() =>
          isDirectory ? onToggle(node.path) : onSelectFile(node.path)
        }
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        <span className="workspace-node-glyph">
          {isDirectory ? (isExpanded ? '▾' : '▸') : '·'}
        </span>
        <span className="workspace-node-label">{node.name}</span>
      </button>
      {isDirectory && isExpanded ? (
        <div className="workspace-children">
          {node.children.map(child => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              selectedFilePath={selectedFilePath}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function WorkspaceExplorer({
  rootPath,
  tree,
  loading,
  error,
  selectedFilePath,
  previewContent,
  previewLoading,
  previewError,
  expandedPaths,
  onRefresh,
  onChooseWorkspace,
  onToggle,
  onSelectFile,
  onInsertReference,
  onCopyPath,
}: Props) {
  return (
    <section className="workspace-column">
      <div className="workspace-card">
        <div className="section-title">项目上下文</div>
        <div className="workspace-toolbar">
          <div className="workspace-root">{rootPath || '未设置工作目录'}</div>
          <div className="header-actions">
            <button className="mini-button" onClick={onChooseWorkspace}>
              更换
            </button>
            <button className="mini-button" onClick={onRefresh}>
              刷新
            </button>
          </div>
        </div>
        {loading ? <p className="muted">正在读取工作区结构...</p> : null}
        {error ? <div className="error-banner">{error}</div> : null}
        {!loading && !error && tree ? (
          <div className="workspace-tree-panel">
            <TreeNode
              node={tree}
              depth={0}
              expandedPaths={expandedPaths}
              selectedFilePath={selectedFilePath}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
            />
          </div>
        ) : null}
      </div>

      <div className="workspace-card preview-card">
        <div className="inline-between">
          <div className="section-title">文件预览</div>
          {selectedFilePath ? (
            <div className="header-actions">
              <button
                className="mini-button"
                onClick={() => onInsertReference(selectedFilePath)}
              >
                引用到输入框
              </button>
              <button className="mini-button" onClick={() => onCopyPath(selectedFilePath)}>
                复制路径
              </button>
            </div>
          ) : null}
        </div>
        {!selectedFilePath ? (
          <p className="muted">从左侧文件树中选择一个文件，就可以在这里预览并快速引用。</p>
        ) : null}
        {previewLoading ? <p className="muted">正在读取文件...</p> : null}
        {previewError ? <div className="error-banner">{previewError}</div> : null}
        {selectedFilePath ? <div className="preview-path">{selectedFilePath}</div> : null}
        {previewContent ? <pre className="preview-content">{previewContent}</pre> : null}
      </div>
    </section>
  )
}

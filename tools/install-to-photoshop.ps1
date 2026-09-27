# 把「选区生图」插件装进 Photoshop
#
# 原理：Photoshop 启动时会扫描自己的 Plug-ins 目录，
#       放在里面的文件夹只要含有 manifest.json 就会被当成 UXP 插件加载。
#       本机已有的第三方插件（sd-ppp2、像素起子、轮椅等）都是这么装的，
#       所以不需要 Creative Cloud，也不需要 UXP Developer Tool。
#
# 用法：双击同目录下的「安装到Photoshop.bat」

$ErrorActionPreference = 'Stop'

$PluginFolderName = '选区生图'

# ---------- 1. 需要管理员权限（Plug-ins 在 Program Files 里面） ----------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '需要管理员权限，正在重新启动脚本，请在弹窗里点「是」...' -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    )
    exit
}

Write-Host ''
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host '    选区生图 - 安装到 Photoshop' -ForegroundColor Cyan
Write-Host '  ============================================' -ForegroundColor Cyan
Write-Host ''

# ---------- 2. 找到插件源码目录 ----------
$source = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $source 'manifest.json'))) {
    Write-Host "  [错误] 找不到 manifest.json，源码目录是：$source" -ForegroundColor Red
    Write-Host '         请保持本脚本在插件的 tools 子目录里，不要单独挪出去。' -ForegroundColor Red
    exit 1
}
Write-Host "  插件源码 : $source" -ForegroundColor Gray

# ---------- 3. 找到 Photoshop 安装目录 ----------
function Find-PhotoshopRoot {
    # 先查注册表里的卸载信息（最准）
    $keys = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $found = Get-ItemProperty $keys -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Adobe Photoshop*' -and $_.InstallLocation } |
        Sort-Object DisplayVersion -Descending
    foreach ($item in $found) {
        $root = $item.InstallLocation.TrimEnd('\')
        if (Test-Path (Join-Path $root 'Required')) { return $root }
    }

    # 注册表没有就扫常见位置
    $bases = @("$env:ProgramFiles", 'D:\Program Files', 'E:\Program Files', 'D:\Program Files\ps', 'E:\Program Files\ps') |
        Where-Object { Test-Path $_ }
    foreach ($base in $bases) {
        $hit = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like 'Adobe Photoshop*' -and (Test-Path (Join-Path $_.FullName 'Required')) } |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$psRoot = Find-PhotoshopRoot
if (-not $psRoot) {
    Write-Host '  [错误] 没找到 Photoshop 安装目录。' -ForegroundColor Red
    Write-Host '         请在 Photoshop 里点「帮助 → 关于 Photoshop」看版本，然后告诉我。' -ForegroundColor Red
    exit 1
}
Write-Host "  Photoshop: $psRoot" -ForegroundColor Gray

$plugInsDir = Join-Path $psRoot 'Plug-ins'
if (-not (Test-Path $plugInsDir)) {
    Write-Host "  [错误] 这个 Photoshop 里没有 Plug-ins 目录：$plugInsDir" -ForegroundColor Red
    exit 1
}

$target = Join-Path $plugInsDir $PluginFolderName

# 安全阀：只允许操作 Plug-ins 目录下的这一个位置
if (-not $target.StartsWith($plugInsDir, [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host '  [错误] 目标路径异常，已中止。' -ForegroundColor Red
    exit 1
}

# ---------- 4. 装之前先关掉 Photoshop ----------
if (Get-Process -Name Photoshop -ErrorAction SilentlyContinue) {
    Write-Host ''
    Write-Host '  请先保存工作并完全关闭 Photoshop，然后重新双击本脚本。' -ForegroundColor Yellow
    Write-Host '  （Photoshop 只在启动时扫描插件目录，开着的时候装不进去）' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

# ---------- 5. 清理旧版本 ----------
if (Test-Path -LiteralPath $target) {
    Write-Host '  移除旧版本...' -ForegroundColor Gray
    Remove-Item -LiteralPath $target -Recurse -Force
}

# ---------- 6. 安装：优先用目录链接，改完代码只重启 PS 就行 ----------
$mode = '复制'
try {
    New-Item -ItemType Junction -Path $target -Target $source -ErrorAction Stop | Out-Null
    $mode = '目录链接（源码改动会自动同步，改完重启 PS 即可）'
}
catch {
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

# ---------- 7. 校验 ----------
if (-not (Test-Path (Join-Path $target 'manifest.json'))) {
    Write-Host '  [错误] 安装后没找到 manifest.json，安装失败。' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host "  安装方式 : $mode" -ForegroundColor Gray
Write-Host "  安装位置 : $target" -ForegroundColor Gray
Write-Host ''
Write-Host '  ============================================' -ForegroundColor Green
Write-Host '    安装完成！' -ForegroundColor Green
Write-Host '  ============================================' -ForegroundColor Green
Write-Host ''
Write-Host '  接下来：' -ForegroundColor White
Write-Host '    1. 打开 Photoshop' -ForegroundColor White
Write-Host '    2. 菜单「增效工具 / 插件」->「选区生图」' -ForegroundColor White
Write-Host ''
Write-Host '  卸载方法：直接删掉上面那个安装位置里的文件夹即可。' -ForegroundColor Gray
Write-Host ''

#!/usr/bin/env bash
# setup.sh — pi-workflow 一键安装。
#
# 装齐这套流程需要的所有东西:
#   1. pi       (npm 全局,@earendil-works/pi-coding-agent)
#   2. pi-subagents (dev/reviewer subagent 插件,pi install)
#   3. beads/bd (brew)
#   4. DEEPSEEK_API_KEY / GLM5_2_API_KEY 写入 ~/.zshrc(交互输入,已存在则跳过)
#   5. 调 install-skills.mjs 把本项目 skill 装到全局
#
# 幂等:已装的跳过,已配的 key 跳过,可反复跑。
# 安全:API key 用 read -s 输入(不回显),绝不打印到终端/日志/命令历史。
#
# 用法:
#   bash scripts/setup.sh           # 全流程
#   bash scripts/setup.sh --no-tools   # 跳过工具安装,只配 key + skill
#   bash scripts/setup.sh --no-keys    # 跳过 key 配置
#   bash scripts/setup.sh --no-skills  # 跳过 skill 安装
#   bash scripts/setup.sh --check      # 只检查现状,不改任何东西

set -euo pipefail

# ---------------------------------------------------------------------------
# 颜色与输出
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""; C_CYAN=""
fi

say()   { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
skip()  { printf "  ${C_YELLOW}○${C_RESET} %s ${C_DIM}(已就绪,跳过)${C_RESET}\n" "$*"; }
info()  { printf "  ${C_CYAN}→${C_RESET} %s\n" "$*"; }
warn()  { printf "  ${C_YELLOW}!${C_RESET} %s\n" "$*" >&2; }
die()   { printf "  ${C_RED}✗ %s${C_RESET}\n" "$*" >&2; exit 1; }
header(){ printf "\n${C_BOLD}${C_BLUE}══ %s ══${C_RESET}\n" "$*"; }

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
DO_TOOLS=1; DO_KEYS=1; DO_SKILLS=1; CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-tools)  DO_TOOLS=0 ;;
    --no-keys)   DO_KEYS=0 ;;
    --no-skills) DO_SKILLS=0 ;;
    --check)     CHECK_ONLY=1; DO_TOOLS=0; DO_KEYS=0; DO_SKILLS=0 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) die "未知参数: $arg(用 --help 看用法)" ;;
  esac
done

# 项目根(脚本在 scripts/ 下)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ZSHRC="${ZSHRC:-$HOME/.zshrc}"

printf "${C_BOLD}${C_BLUE}pi-workflow 一键安装${C_RESET}\n"
printf "${C_DIM}  project: %s${C_RESET}\n" "$PROJECT_ROOT"
printf "${C_DIM}  zshrc:  %s${C_RESET}\n" "$ZSHRC"
if [[ $CHECK_ONLY == 1 ]]; then
  printf "${C_YELLOW}  ⚠ CHECK 模式:只检查,不改任何东西${C_RESET}\n"
fi

# ---------------------------------------------------------------------------
# 工具检测/安装
# ---------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

install_tools() {
  header "第 1 步:安装工具(pi / beads)"

  # --- pi (npm 全局)---
  if have pi; then
    skip "pi 已装 $(pi --version 2>/dev/null || echo '?')"
  else
    info "装 pi(pi coding-agent)"
    have npm || die "装 pi 需要 npm。请先装 Node.js(brew install node)。"
    npm install -g @earendil-works/pi-coding-agent || die "npm install pi 失败"
    say "pi 装好 $(pi --version 2>/dev/null || echo '')"
  fi

  # --- pi-subagents (subagent 能力,dev/reviewer 依赖)---
  if pi list 2>/dev/null | grep -q "pi-subagents"; then
    skip "pi-subagents 已装"
  else
    info "装 pi-subagents(dev/reviewer subagent 插件)"
    pi install npm:pi-subagents || die "pi install pi-subagents 失败"
    say "pi-subagents 装好"
  fi

  # --- beads/bd (brew)---
  if have bd; then
    skip "bd 已装 $(bd --version 2>/dev/null || echo '?')"
  else
    info "装 beads(bd)"
    have brew || die "装 beads 需要 Homebrew。请先装 brew(https://brew.sh)。"
    brew install beads || die "brew install beads 失败"
    say "bd 装好"
  fi
}

# ---------------------------------------------------------------------------
# API key 配置
# ---------------------------------------------------------------------------
# 判断 zshrc 是否已有某 key 的 export 行(精确匹配,避免误判注释行)
has_key_in_zshrc() {
  local key="$1"
  [[ -f "$ZSHRC" ]] && grep -qE "^[[:space:]]*export[[:space:]]+${key}=" "$ZSHRC"
}

# 交互读取一个 key(不回显)。$1=变量名 $2=提示。读到非空值则赋给 $1。
# 若用户直接回车,返回空(=跳过这个 key)。
prompt_key() {
  local varname="$1" prompt="$2"
  local val
  # read -s:不回显;-r:不处理反斜杠
  printf "  ${C_CYAN}?${C_RESET} %s ${C_DIM}(输入不可见,回车跳过)${C_RESET}: " "$prompt"
  read -rs val
  printf "\n"
  printf -v "$varname" '%s' "$val"
}

configure_keys() {
  header "第 2 步:配置 API key(写入 $ZSHRC)"

  local need_deepseek=1 need_glm=1
  if has_key_in_zshrc "DEEPSEEK_API_KEY"; then
    skip "DEEPSEEK_API_KEY 已在 zshrc"
    need_deepseek=0
  fi
  if has_key_in_zshrc "GLM5_2_API_KEY"; then
    skip "GLM5_2_API_KEY 已在 zshrc"
    need_glm=0
  fi

  if [[ $need_deepseek == 0 && $need_glm == 0 ]]; then
    say "两个 key 都已配置,无需操作"
    return
  fi

  if [[ $CHECK_ONLY == 1 ]]; then
    warn "CHECK 模式:检测到缺 key 但不交互输入。退出。"
    return
  fi

  echo ""
  echo "  ${C_DIM}需要从对应平台获取 key:${C_RESET}"
  echo "  ${C_DIM}  DEEPSEEK_API_KEY  ← https://platform.deepseek.com/${C_RESET}"
  echo "  ${C_DIM}  GLM5_2_API_KEY    ← https://open.bigmodel.cn/(智谱 GLM)${C_RESET}"
  echo ""

  local deepseek_key="" glm_key=""
  if [[ $need_deepseek == 1 ]]; then
    prompt_key deepseek_key "DEEPSEEK_API_KEY"
  fi
  if [[ $need_glm == 1 ]]; then
    prompt_key glm_key "GLM5_2_API_KEY"
  fi

  # 只在至少有一个非空 key 时才追加
  if [[ -z "$deepseek_key" && -z "$glm_key" ]]; then
    warn "两个 key 都没输入,跳过。之后可手动加到 $ZSHRC"
    return
  fi

  info "追加到 $ZSHRC"
  {
    echo ""
    echo "# pi-workflow API keys(由 scripts/setup.sh 添加 $(date +%Y-%m-%d))"
    [[ -n "$deepseek_key" ]] && echo "export DEEPSEEK_API_KEY='$deepseek_key'"
    [[ -n "$glm_key" ]]      && echo "export GLM5_2_API_KEY='$glm_key'"
  } >> "$ZSHRC"
  say "key 已写入(zshrc 末尾)"

  # 提示重载
  echo ""
  echo "  ${C_DIM}key 已写入但要新开终端(或 source ~/.zshrc)才生效。${C_RESET}"
}

# ---------------------------------------------------------------------------
# skill 安装
# ---------------------------------------------------------------------------
install_skills() {
  header "第 3 步:安装 skill 到全局 pi skill 根"
  if [[ ! -f "$PROJECT_ROOT/scripts/install-skills.mjs" ]]; then
    warn "找不到 scripts/install-skills.mjs,跳过 skill 安装"
    return
  fi
  have node || { warn "没有 node,跳过 skill 安装"; return; }
  info "运行 install-skills.mjs(symlink 模式)"
  (cd "$PROJECT_ROOT" && node scripts/install-skills.mjs) || warn "skill 安装有报错(见上)"
}

# 第 4 步:安装 wfpi 命令到 ~/.zshrc(任意目录一键启动 pi + workflow 扩展)
install_wfpi() {
  header "第 4 步:安装 wfpi 命令(~/.zshrc)"
  local zshrc="${HOME}/.zshrc"
  local marker="# --- workflow-agent:wfpi 命令"
  if grep -q "$marker" "$zshrc" 2>/dev/null; then
    skip "wfpi 已在 ~/.zshrc"
  else
    info "写入 wfpi 到 ~/.zshrc"
    cat >> "$zshrc" << EOF

$marker(任意目录一键启动 pi + workflow 扩展) ---
export WF_AGENT_HOME="$PROJECT_ROOT"
wfpi() { "\$WF_AGENT_HOME/scripts/wfpi" "\$@"; }
EOF
    say "wfpi 已写入 ~/.zshrc(source ~/.zshrc 或重开终端生效)"
  fi
}

# ---------------------------------------------------------------------------
# 执行
# ---------------------------------------------------------------------------
[[ $DO_TOOLS  == 1 ]] && install_tools  || header "第 1 步:安装工具(--no-tools 跳过)"
[[ $DO_TOOLS  == 0 ]] && echo "  ${C_DIM}已跳过${C_RESET}"

[[ $DO_KEYS   == 1 ]] && configure_keys || header "第 2 步:配置 key(--no-keys 跳过)"
[[ $DO_KEYS   == 0 ]] && echo "  ${C_DIM}已跳过${C_RESET}"

[[ $DO_SKILLS == 1 ]] && install_skills || header "第 3 步:安装 skill(--no-skills 跳过)"
[[ $DO_SKILLS == 0 ]] && echo "  ${C_DIM}已跳过${C_RESET}"

[[ $DO_TOOLS == 1 ]] && install_wfpi

# ---------------------------------------------------------------------------
# 收尾:验证
# ---------------------------------------------------------------------------
header "验证"
printf "  %-18s" "pi";      have pi      && printf "${C_GREEN}✓ %s${C_RESET}\n" "$(pi --version 2>/dev/null)"      || printf "${C_YELLOW}✗ 未装${C_RESET}\n"
printf "  %-18s" "pi-subagents"; pi list 2>/dev/null | grep -q "pi-subagents" && printf "${C_GREEN}✓ 已装${C_RESET}\n" || printf "${C_YELLOW}✗ 未装${C_RESET}\n"
printf "  %-18s" "bd";       have bd       && printf "${C_GREEN}✓ %s${C_RESET}\n" "$(bd --version 2>/dev/null)"       || printf "${C_YELLOW}✗ 未装${C_RESET}\n"

printf "  %-18s" "DEEPSEEK_API_KEY"
if has_key_in_zshrc "DEEPSEEK_API_KEY"; then printf "${C_GREEN}✓ 已在 zshrc${C_RESET}\n"
else printf "${C_YELLOW}✗ 未配${C_RESET}\n"; fi
printf "  %-18s" "GLM5_2_API_KEY"
if has_key_in_zshrc "GLM5_2_API_KEY"; then printf "${C_GREEN}✓ 已在 zshrc${C_RESET}\n"
else printf "${C_YELLOW}✗ 未配${C_RESET}\n"; fi

echo ""
echo "  ${C_BOLD}完成。${C_RESET}新开终端让 key 生效,然后在任意目录跑 pi 就能用 /wf、/execute。"
echo "  ${C_DIM}第一次在目标 repo 用:cd <repo> && bd init && /wf new <需求>${C_RESET}"

# -*- coding: utf-8 -*-
"""
把本源码自动传到 GitHub 并触发云端编译 APK

用法：在这个文件夹里双击本文件（或在命令行 python 上传GitHub.py）
需要：电脑能上 GitHub + 一个 GitHub 账号 + 一个 Token

Token 申请：浏览器打开 https://github.com/settings/tokens/new
  勾 repo（全部子项）  ->  Generate token  ->  复制那串 ghp_xxx
"""
import getpass
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.github.com"
TOKEN_FILE = os.path.join(HERE, "._github_token")


def sh(args, show=True):
    p = subprocess.run(args, cwd=HERE, capture_output=True, text=True, encoding="utf-8", errors="ignore")
    if show and (p.stdout or p.stderr):
        print((p.stdout or "") + (p.stderr or ""))
    return p.returncode, p.stdout, p.stderr


def api(path, token, data=None, method=None):
    req = urllib.request.Request(API + path, method=method or ("POST" if data else "GET"))
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "shizhanqu-uploader")
    body = json.dumps(data).encode() if data else None
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, body, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")


def main():
    print("=" * 60)
    print("  入库实战区 · 安卓源码上传 GitHub（编 APK 第一步）")
    print("=" * 60)

    if not os.path.isdir(os.path.join(HERE, ".git")):
        print("未发现 git 仓库，先初始化...")
        sh(["git", "init", "-q"])
        sh(["git", "config", "user.name", "shizhanqu"])
        sh(["git", "config", "user.email", "shizhanqu@local"])

    # 仓库里可能又有新改动，先提交
    sh(["git", "add", "-A"], show=False)
    rc, out, _ = sh(["git", "status", "--porcelain"], show=False)
    if out.strip():
        print("检测到本地有未提交的改动，先提交...")
        sh(["git", "-c", "core.safecrlf=false", "commit", "-q", "-m", "更新源码"], show=False)
    sh(["git", "branch", "-M", "main"], show=False)

    user = input("GitHub 用户名: ").strip()
    if not user:
        print("用户名不能为空")
        return 1

    token = ""
    if os.path.exists(TOKEN_FILE):
        try:
            token = open(TOKEN_FILE, encoding="utf-8").read().strip()
        except Exception:
            token = ""
    if token:
        print("已使用上次保存的 Token（删除 ._github_token 可换）")
    else:
        print("\n还没有 Token？打开下面链接，勾 repo 后生成，再粘回来：")
        print("  https://github.com/settings/tokens/new")
        token = getpass.getpass("Token（粘贴时不显示，回车确认）: ").strip()
    if not token:
        print("Token 不能为空")
        return 1

    repo = input("仓库名（直接回车用 shizhanqu-android）: ").strip() or "shizhanqu-android"
    priv = input("私有仓库？直接回车=私有，输入 n =公开: ").strip().lower() != "n"

    print("\n1) 检查 Token ...")
    try:
        me = api("/user", token)
        print("   登录身份:", me.get("login"))
    except urllib.error.HTTPError as e:
        print("   Token 无效或网络不通（HTTP %s）" % e.code)
        return 1
    except Exception as e:
        print("   连接失败：%s" % e)
        print("   这台机器可能上不了 GitHub，换一台能上网的电脑再运行本脚本。")
        return 1

    try:
        open(TOKEN_FILE, "w", encoding="utf-8").write(token)
    except Exception:
        pass

    print("2) 创建仓库 %s/%s ..." % (user, repo))
    try:
        api("/user/repos", token, {"name": repo, "private": priv, "auto_init": False})
        print("   已创建")
    except urllib.error.HTTPError as e:
        if e.code in (400, 422):
            print("   仓库已存在，直接用它")
        else:
            print("   创建失败 HTTP %s：%s" % (e.code, e.read().decode()[:200]))
            return 1

    url = "https://%s:%s@github.com/%s/%s.git" % (user, token, repo, repo)
    sh(["git", "remote", "remove", "origin"], show=False)
    sh(["git", "remote", "add", "origin", url], show=False)

    print("3) 上传源码 ...")
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    p = subprocess.run(["git", "push", "-u", "origin", "main"], cwd=HERE, env=env,
                       capture_output=True, text=True, encoding="utf-8", errors="ignore")
    tail = ((p.stdout or "") + (p.stderr or "")).strip().splitlines()
    for line in tail[-15:]:
        print("   " + line)
    if p.returncode != 0:
        print("\n上传失败。常见原因：网络不通 / Token 权限没勾 repo / 仓库名冲突。")
        return 1

    # 把明文 token 从远程地址里抹掉
    sh(["git", "remote", "set-url", "origin", "https://github.com/%s/%s.git" % (user, repo)], show=False)

    acts = "https://github.com/%s/%s/actions" % (user, repo)
    print("\n" + "=" * 60)
    print("  上传成功！云端已开始自动编译，约 3~5 分钟。")
    print("  打开这个页面看进度：%s" % acts)
    print("  进度里那一条变绿后，点进去，在页面最下面 Artifacts")
    print("  下载【入库实战区APK】，解压后就是 apk 文件。")
    print("=" * 60)
    try:
        webbrowser.open(acts)
    except Exception:
        pass
    input("\n回车关闭...")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消")

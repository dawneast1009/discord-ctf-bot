# Koyeb 무료 배포 가이드

Koyeb는 GitHub 레포를 연결하면 `Dockerfile`로 자동 빌드·실행해 줍니다.
무료 서비스 1개는 sleep 없이 24시간 돌아갑니다.

## 1. GitHub에 코드 올리기

```bash
cd discord-ctf-bot
git init
git add .
git commit -m "CTF discord bot"
# GitHub에서 빈 레포 만든 뒤:
git remote add origin https://github.com/<내계정>/discord-ctf-bot.git
git branch -M main
git push -u origin main
```
> `.gitignore` 에 `.env`, `node_modules`, `dist`, `data.json` 가 빠지도록 되어 있어 토큰은 올라가지 않습니다.

## 2. Koyeb에서 서비스 생성

1. https://app.koyeb.com 가입 → **Create Service** → **GitHub** 선택, 위 레포 연결.
2. **Builder**: `Dockerfile` 자동 인식 (그대로 두기).
3. **Instance**: 무료(`Free` / nano) 선택.
4. **Ports**: `8000` (health 서버 포트) — 보통 자동 감지됨.
5. **Environment variables** 에 추가:
   - `DISCORD_TOKEN` = 봇 토큰
   - `GUILD_IDS` = 내 서버 ID (선택, 명령어 즉시 등록용)
6. **Deploy** 클릭.

## 3. 확인
- 로그(Logs)에 `로그인 완료: ...` / `헬스체크 서버 실행: :8000` 뜨면 성공.
- 디스코드에서 `/문제 생성` 테스트.

## ⚠️ 중요: 데이터 영속성
Koyeb 무료는 **영구 디스크가 없어서**, 재배포·재시작하면 `data.json` 이 사라집니다.
→ 그러면 기존 문제의 "문제의 답" 버튼이 동작하지 않게 됩니다(문제 정보 소실).

해결: 외부 무료 DB(예: **Upstash Redis** — 카드 없이 무료)에 저장하도록 바꾸면
재시작에도 안전합니다. 필요하면 그 작업을 이어서 해드릴게요.

APP  = dist/Slimey-darwin-arm64/Slimey.app
DEST = /Applications/Slimey.app

.PHONY: help setup start check build install win icon app-icon shots

help: ## 이 목록
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{ printf "  make %-10s %s\n", $$1, $$2 }'

setup: ## npm install
	npm install

start: ## 슬라임 띄우기 (개발용, 터미널에 붙어 있음)
	npm start

check: ## 창 없이 세션 표·PR 조회 결과만 터미널에 출력
	npm run check

build: ## 앱 아이콘 만들고 macOS .app 빌드 (dist/)
	npm run build

install: build ## 빌드 → 실행 중인 Slimey 종료 → /Applications 교체 → 실행
	-osascript -e 'quit app "Slimey"'
	rm -rf $(DEST) && cp -R $(APP) $(DEST)
	open $(DEST)

win: ## Windows 빌드 (dist/Slimey-win32-x64)
	npm run build:win

icon: ## 메뉴바 아이콘 PNG 다시 그리기 (scripts/tray-icon.py)
	npm run icon

app-icon: ## 앱(Finder·독) 아이콘 build/icon.icns 다시 만들기
	npm run app-icon

shots: ## README 스크린샷 다시 찍기 (docs/)
	npm run shots

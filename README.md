## 1. Bitcoin 노드 실행

```powershell

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\lab.ps1 Start
```

## 2. 대시보드 실행

새 PowerShell 창에서

```powershell

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\dashboard.ps1 Start `
  -BindAddress 0.0.0.0
```

## 3. 접속 주소

```text
현재 PC: http://127.0.0.1:8000
다른 기기: http://192.168.0.10:8000
접속 키: .local/access.json 파일 확인
```


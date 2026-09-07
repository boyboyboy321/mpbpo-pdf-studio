!macro NSIS_HOOK_POSTINSTALL
  ; Fixed WebView2 120+ needs these read/execute grants for its Windows 10 sandbox.
  Push $0
  nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR\resources\webview2" /grant "*S-1-15-2-2:(OI)(CI)(RX)" "*S-1-15-2-1:(OI)(CI)(RX)" /q'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONSTOP "Could not prepare WebView2 permissions. Please run the installer again in a local folder you can write to." /SD IDOK
    Pop $0
    SetErrorLevel 1
    Abort
  ${EndIf}
  Pop $0
!macroend

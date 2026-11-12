Var WispUpdateSignal
Var WispUpdateProgressProcess

!macro WispCreateUpdateSignal
  ; The hidden control belongs to the GUI thread so its properties survive an abort.
  System::Call 'user32::CreateWindowExW(i 0, w "Static", p 0, i 0x40000000, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0) p.s'
  Pop $WispUpdateSignal
!macroend

!macro WispStartProgress
  Push $0
  Push $1
  Push $2
  Push $3
  ; NSIS is 32-bit. Keep the process handle to join the updater before cleanup.
  ; STARTUPINFOW has eight DWORDs after lpTitle, ending with dwFlags.
  System::Call '*(i 68, p 0, p 0, p 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, &i2 0, &i2 0, p 0, p 0, p 0, p 0) p.r0'
  System::Call '*(p 0, p 0, i 0, i 0) p.r1'
  StrCpy $3 '"$PLUGINSDIR\wisp-update-helper.exe" --installer-progress-svelte $mui.InstFilesPage.ProgressBar $WispUpdateSignal "$WispUpdateLog"'
  System::Call 'kernel32::CreateProcessW(w "$PLUGINSDIR\wisp-update-helper.exe", w r3, p 0, p 0, i 0, i 0, p 0, p 0, p r0, p r1) i.r2'
  ${If} $2 != 0
    System::Call '*$1(p.s, p.r2)'
    Pop $WispUpdateProgressProcess
    System::Call 'kernel32::CloseHandle(p r2)'
  ${EndIf}
  System::Free $1
  System::Free $0
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro WispStopProgress
  ${If} $WispUpdateProgressProcess != ""
    System::Call 'user32::SetPropW(p $WispUpdateSignal, w "WispProgressDone", p 1)'
    System::Call 'kernel32::WaitForSingleObject(p $WispUpdateProgressProcess, i 500)'
    System::Call 'kernel32::CloseHandle(p $WispUpdateProgressProcess)'
    StrCpy $WispUpdateProgressProcess ""
  ${EndIf}
!macroend

!macro WispTryCustomWindow
  Push $0
  Push $1
  Push $2
  ; HIGHCONTRASTW is 12 bytes in NSIS. Respect the user's Windows contrast theme.
  System::Call '*(i 12, i 0, p 0) p.r0'
  System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r0, i 0) i.r1'
  ${If} $1 != 0
    System::Call '*$0(i, i.r1)'
    IntOp $1 $1 & 1
    ${If} $1 == 0
    ${AndIf} $WispUpdateSignal != 0
      !insertmacro WispStartProgress
      ${If} $WispUpdateProgressProcess != ""
        StrCpy $2 0
        ${Do}
          System::Call 'user32::GetPropW(p $WispUpdateSignal, w "WispProgressReady") p.r1'
          ${If} $1 != 0
            ShowWindow $HWNDPARENT ${SW_HIDE}
            ${ExitDo}
          ${EndIf}
          System::Call 'kernel32::WaitForSingleObject(p $WispUpdateProgressProcess, i 25) i.r1'
          IntOp $2 $2 + 1
          ${If} $1 != 258 ; WAIT_TIMEOUT
          ${OrIf} $2 == 200 ; Five seconds for a cold WebView startup.
            !insertmacro WispStopProgress
            ${ExitDo}
          ${EndIf}
        ${Loop}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  System::Free $0
  Pop $2
  Pop $1
  Pop $0
!macroend

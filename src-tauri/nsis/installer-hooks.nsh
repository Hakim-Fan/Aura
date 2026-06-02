!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$SMPROGRAMS\Aura"
  CreateShortCut "$SMPROGRAMS\Aura\Aura.lnk" "$INSTDIR\Aura.exe" "" "$INSTDIR\Aura.exe" 0
  CreateShortCut "$DESKTOP\Aura.lnk" "$INSTDIR\Aura.exe" "" "$INSTDIR\Aura.exe" 0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\Aura.lnk"
  Delete "$SMPROGRAMS\Aura\Aura.lnk"
  RMDir "$SMPROGRAMS\Aura"
!macroend

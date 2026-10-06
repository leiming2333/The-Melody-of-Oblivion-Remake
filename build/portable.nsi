!include "common.nsh"
!include "extractAppPackage.nsh"

CRCCheck off
WindowIcon Off
AutoCloseWindow True
RequestExecutionLevel user

Var CacheRoot
Var CacheKey
Var CacheFinal
Var CacheStaging
Var CacheMutex
Var CacheReady
Var ProbeFile
Var ProcessId
Var /GLOBAL packageArch

Function .onInit
  SetSilent silent
  !insertmacro check64BitAndSetRegView
FunctionEnd

Function .onGUIInit
  InitPluginsDir
FunctionEnd

Function CheckCache
  StrCpy $CacheReady 0
  IfFileExists "$CacheFinal\.complete" 0 done
  IfFileExists "$CacheFinal\${APP_EXECUTABLE_FILENAME}" 0 done
  IfFileExists "$CacheFinal\resources\app.asar" 0 done
  IfFileExists "$CacheFinal\icudtl.dat" 0 done
  IfFileExists "$CacheFinal\resources.pak" 0 done
  IfFileExists "$CacheFinal\v8_context_snapshot.bin" 0 done
  IfFileExists "$CacheFinal\locales\en-US.pak" 0 done
  StrCpy $CacheReady 1
  done:
FunctionEnd

Section
  !insertmacro identify_package
  ${if} $packageArch == "ARM64"
    !ifdef MELODY_CACHE_ARM64
      StrCpy $CacheKey "${MELODY_CACHE_ARM64}"
    !endif
  ${elseif} $packageArch == "64"
    !ifdef MELODY_CACHE_64
      StrCpy $CacheKey "${MELODY_CACHE_64}"
    !endif
  ${else}
    !ifdef MELODY_CACHE_32
      StrCpy $CacheKey "${MELODY_CACHE_32}"
    !endif
  ${endif}
  StrCmp $CacheKey "" failed

  StrCpy $CacheRoot "$EXEDIR\启动器运行文件"
  StrCpy $CacheFinal "$CacheRoot\$CacheKey"
  Call CheckCache
  StrCmp $CacheReady 1 launch

  ; Check actual write access, then fall back without requiring administrator rights.
  ClearErrors
  CreateDirectory "$CacheRoot"
  GetTempFileName $ProbeFile "$CacheRoot"
  IfErrors fallback 0
  Delete "$ProbeFile"
  Goto acquire
  fallback:
    StrCpy $CacheRoot "$LOCALAPPDATA\MelodyOfOblivion\portable-runtime"
    StrCpy $CacheFinal "$CacheRoot\$CacheKey"
    Call CheckCache
    StrCmp $CacheReady 1 launch
    ClearErrors
    CreateDirectory "$CacheRoot"
    GetTempFileName $ProbeFile "$CacheRoot"
    IfErrors failed 0
    Delete "$ProbeFile"

  acquire:
    ; Serialize first extraction; a crashed process releases this mutex automatically.
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\MelodyPortable-$CacheKey") p.r0'
    StrCpy $CacheMutex $0
    StrCmp $CacheMutex 0 failed
    System::Call 'kernel32::WaitForSingleObject(p $CacheMutex, i 60000) i.r0'
    ${if} $0 != 0
    ${andIf} $0 != 128
      System::Call 'kernel32::CloseHandle(p $CacheMutex)'
      Goto failed
    ${endif}
    Call CheckCache
    StrCmp $CacheReady 1 release

    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $ProcessId $0
    ; GetTempFileName gives each extraction a unique path, including after interruption.
    ClearErrors
    GetTempFileName $CacheStaging "$CacheRoot"
    IfErrors extraction_failed 0
    Delete "$CacheStaging"
    CreateDirectory "$CacheStaging"
    IfErrors extraction_failed 0
    StrCpy $INSTDIR "$CacheStaging"
    SetOutPath "$INSTDIR"
    ClearErrors
    !ifdef COMPRESS
      SetCompress off
    !endif
    !insertmacro compute_files_for_current_arch
    !ifdef COMPRESS
      SetCompress "${COMPRESS}"
    !endif
    !insertmacro decompress
    !insertmacro custom_files_post_decompression
    IfErrors extraction_failed 0
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 extraction_failed
    IfFileExists "$INSTDIR\resources\app.asar" 0 extraction_failed
    ClearErrors
    FileOpen $0 "$INSTDIR\.complete" w
    IfErrors extraction_failed 0
    FileWrite $0 "$CacheKey"
    FileClose $0
    IfErrors extraction_failed 0
    SetOutPath "$CacheRoot"
    ; Preserve incomplete/corrupt caches instead of deleting potentially running files.
    IfFileExists "$CacheFinal\*.*" 0 commit
    ClearErrors
    Rename "$CacheFinal" "$CacheFinal.incomplete-$ProcessId"
    IfErrors extraction_failed 0
    commit:
      ClearErrors
      Rename "$CacheStaging" "$CacheFinal"
      IfErrors extraction_failed 0
    Call CheckCache
    StrCmp $CacheReady 1 release extraction_failed

  release:
    System::Call 'kernel32::ReleaseMutex(p $CacheMutex)'
    System::Call 'kernel32::CloseHandle(p $CacheMutex)'

  launch:
    StrCpy $INSTDIR "$CacheFinal"
    SetOutPath "$EXEDIR"
    System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_DIR", w "$EXEDIR")'
    System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_FILE", w "$EXEPATH")'
    System::Call 'kernel32::SetEnvironmentVariableW(w "PORTABLE_EXECUTABLE_APP_FILENAME", w "${APP_FILENAME}")'
    ${StdUtils.GetAllParameters} $R0 0
    ClearErrors
    ExecWait '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $R0' $0
    IfErrors failed 0
    SetErrorLevel $0
    Goto done

  extraction_failed:
    SetOutPath "$EXEDIR"
    System::Call 'kernel32::ReleaseMutex(p $CacheMutex)'
    System::Call 'kernel32::CloseHandle(p $CacheMutex)'
  failed:
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法准备启动器运行文件。请检查文件夹权限、磁盘空间，或关闭启动器后重试。"
    SetErrorLevel 1
  done:
SectionEnd

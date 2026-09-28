@echo off
rem ============================================================
rem  مداد — إضافة استثناءات Windows Defender (نقر مزدوج)
rem  .bat ضروري لان Windows لا يشغّل .ps1 بالنقر المزدوج.
rem  -Verb RunAs يعرض نافذة UAC ويرفع الصلاحية (Set-MpPreference يرفض بدون Admin).
rem  -Wait يجعل هذه النافذة تنتظر انتهاء جلسة الـ Admin.
rem ============================================================
chcp 65001 >nul
title Medad - Fix Defender
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0_tools\add_av_exclusions.ps1""'"
echo.
echo Done - press any key...
pause >nul

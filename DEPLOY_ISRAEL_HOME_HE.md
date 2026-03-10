# פריסה אמינה מישראל (חינם)

המטרה: לעבוד עם מקור רשמי של פיקוד העורף בלי חסימות `403` של שרתי ענן.

## למה זה נחוץ

פיקוד העורף חוסם גישה משרתי ענן (Render וכו').  
מהמחשב שלך בישראל הנתונים כן נגישים, לכן זה המסלול האמין.

## מה כבר הוכן

- שירות מערכת קבוע לשרת (`launchd`) דרך:
  - `scripts/setup_launchd.sh`
- בדיקות בריאות מהירות:
  - `scripts/check_stack.sh`
- בדיקות פיצ'רים:
  - `scripts/check_features.sh`
- Tunnel ציבורי זמני:
  - `scripts/start_public_tunnel.sh`
- עדכון DuckDNS אוטומטי (אופציונלי לקישור קבוע):
  - `scripts/setup_duckdns.sh`

## 1) הפעלה קבועה של השרת

```bash
/Users/amit/Downloads/red-alert/scripts/setup_launchd.sh
```

בדיקה:

```bash
/Users/amit/Downloads/red-alert/scripts/check_stack.sh
/Users/amit/Downloads/red-alert/scripts/check_features.sh
```

## 2) שיתוף מיידי (קישור זמני)

```bash
/Users/amit/Downloads/red-alert/scripts/start_public_tunnel.sh
```

הסקריפט יחזיר URL ציבורי.

## 3) קישור קבוע אמיתי (מומלץ)

1. פתח פורט בראוטר:
   - WAN `3000` -> `192.168.1.20:3000` (IP מקומי של המחשב שלך)
2. צור דומיין ב-DuckDNS (חינם)
3. הפעל updater אוטומטי:

```bash
/Users/amit/Downloads/red-alert/scripts/setup_duckdns.sh <domain> <token>
```

4. הכתובת שלך תהיה:

```text
http://<domain>.duckdns.org:3000
```

## הערה חשובה

כדי שזה יהיה זמין תמיד:

- המחשב צריך להיות דלוק
- האינטרנט הביתי צריך להיות פעיל
- מומלץ להגדיר למחשב IP פנימי קבוע בראוטר (DHCP Reservation)

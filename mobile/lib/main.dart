// =============================================================================
//  ERP SCOLAIRE RDC — Application Enseignant (Flutter)
//  • Appel hors-ligne : interrupteur vert (présent) / rouge (absent) par élève
//  • Indicateur par ligne : nuage orange = stocké dans sqflite, coche verte = synchronisé
//  • Saisie rapide des cotes (tableau clavier numérique, passage automatique à l'élève suivant)
//  • File d'attente HTTP persistante (table outbox) rejouée vers l'API Node :
//    lots, accusés par enregistrement, backoff exponentiel, reprise au retour du réseau
//
//  Lancement :  flutter run --dart-define=API_URL=https://schoolap-erp-api.onrender.com
// =============================================================================

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

/// URL de l'API (modifiable dans l'écran de connexion → « Paramètres du serveur »).
/// 10.0.2.2 = machine hôte vue depuis l'émulateur Android.
const String kDefaultApiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://10.0.2.2:4000');

const Color kNavy = Color(0xFF0B2545);
const Color kNavyLight = Color(0xFF1D4E89);
const Color kPresentGreen = Color(0xFF1B7F3B);
const Color kAbsentRed = Color(0xFFC62828);
const Color kPendingOrange = Color(0xFFEF6C00);
const Color kGrey = Color(0xFF64748B);

const int kSyncBatchSize = 100;
const int kMaxPastDays = 60;
const List<String> kTerms = ['T1', 'T2', 'T3'];
const List<String> kEvaluations = ['Interrogation 1', 'Interrogation 2', 'Interrogation 3', 'Devoir', 'Examen'];

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final db = await LocalDb.open();
  final controller = AppController(db: db, connectivity: PluginConnectivity());
  await controller.init();
  runApp(EcoleApp(controller: controller));
}

// =============================================================================
//  Utilitaires
// =============================================================================

String isoDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

DateTime parseIsoDate(String iso) {
  final parts = iso.split('-').map(int.parse).toList();
  return DateTime(parts[0], parts[1], parts[2]);
}

const _joursFr = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const _moisFr = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

String formatDateFr(String iso) {
  final d = parseIsoDate(iso);
  final s = '${_joursFr[d.weekday - 1]} ${d.day} ${_moisFr[d.month - 1]} ${d.year}';
  return s[0].toUpperCase() + s.substring(1);
}

String formatTime(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

final Random _secureRandom = Random.secure();

/// UUID v4 (RFC 4122) généré sur l'appareil : identifiant stable même hors-ligne.
String newUuid() {
  final b = List<int>.generate(16, (_) => _secureRandom.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// Horodatage envoyé au serveur (dernière écriture gagnante) : toujours en UTC.
String nowUtcIso() => DateTime.now().toUtc().toIso8601String();

/// Accepte « 14 », « 14,5 », « 14.5 » ; null si vide ou invalide.
double? parseScore(String raw) {
  final t = raw.trim().replaceAll(',', '.');
  if (t.isEmpty) return null;
  return double.tryParse(t);
}

String formatScore(double v) => v == v.roundToDouble() ? v.toStringAsFixed(0) : v.toStringAsFixed(2).replaceAll(RegExp(r'0$'), '').replaceAll('.', ',');

String? normalizeDrcPhone(String input) {
  var d = input.trim().replaceAll(RegExp(r'[\s.\-()]'), '');
  if (d.startsWith('+')) d = d.substring(1);
  if (d.startsWith('00')) d = d.substring(2);
  if (d.startsWith('0') && d.length == 10) d = '243${d.substring(1)}';
  final e164 = '+$d';
  return RegExp(r'^\+243[89]\d{8}$').hasMatch(e164) ? e164 : null;
}

// =============================================================================
//  Modèles
// =============================================================================

class SchoolClass {
  const SchoolClass({required this.id, required this.name, required this.level, this.option});
  final String id;
  final String name;
  final String level;
  final String? option;

  factory SchoolClass.fromRow(Map<String, Object?> r) =>
      SchoolClass(id: r['id'] as String, name: r['name'] as String, level: r['level'] as String, option: r['option'] as String?);
}

class Student {
  const Student({
    required this.id,
    required this.classId,
    required this.matricule,
    required this.lastName,
    required this.middleName,
    required this.firstName,
  });
  final String id;
  final String classId;
  final String matricule;
  final String lastName;
  final String middleName;
  final String firstName;

  /// Convention RDC : NOM POSTNOM Prénom
  String get fullName => [lastName.toUpperCase(), middleName.toUpperCase(), firstName].where((s) => s.isNotEmpty).join(' ');
  String get initials => '${lastName.isNotEmpty ? lastName[0] : ''}${firstName.isNotEmpty ? firstName[0] : ''}'.toUpperCase();

  factory Student.fromRow(Map<String, Object?> r) => Student(
        id: r['id'] as String,
        classId: r['class_id'] as String,
        matricule: r['matricule'] as String,
        lastName: r['last_name'] as String,
        middleName: (r['middle_name'] as String?) ?? '',
        firstName: r['first_name'] as String,
      );
}

class Subject {
  const Subject({required this.id, required this.name, required this.defaultMaxScore});
  final String id;
  final String name;
  final double defaultMaxScore;

  factory Subject.fromRow(Map<String, Object?> r) =>
      Subject(id: r['id'] as String, name: r['name'] as String, defaultMaxScore: (r['default_max_score'] as num).toDouble());
}

/// État de synchronisation d'un enregistrement local.
enum SyncState { local, synced, error }

class AttendanceEntry {
  const AttendanceEntry({
    required this.id,
    required this.studentId,
    required this.classId,
    required this.date,
    required this.isPresent,
    required this.clientUpdatedAt,
    required this.isSynced,
    this.syncError,
    this.smsStatus,
  });
  final String id;
  final String studentId;
  final String classId;
  final String date;
  final bool isPresent;
  final String clientUpdatedAt;
  final bool isSynced;
  final String? syncError;
  final String? smsStatus;

  SyncState get state => syncError != null ? SyncState.error : (isSynced ? SyncState.synced : SyncState.local);

  factory AttendanceEntry.fromRow(Map<String, Object?> r) => AttendanceEntry(
        id: r['id'] as String,
        studentId: r['student_id'] as String,
        classId: r['class_id'] as String,
        date: r['date'] as String,
        isPresent: r['status'] == 'PRESENT',
        clientUpdatedAt: r['client_updated_at'] as String,
        isSynced: (r['is_synced'] as int) == 1,
        syncError: r['sync_error'] as String?,
        smsStatus: r['sms_status'] as String?,
      );
}

class GradeEntry {
  const GradeEntry({
    required this.id,
    required this.studentId,
    required this.subjectId,
    required this.term,
    required this.evaluation,
    required this.maxScore,
    required this.score,
    required this.isSynced,
    this.syncError,
  });
  final String id;
  final String studentId;
  final String subjectId;
  final String term;
  final String evaluation;
  final double maxScore;
  final double score;
  final bool isSynced;
  final String? syncError;

  SyncState get state => syncError != null ? SyncState.error : (isSynced ? SyncState.synced : SyncState.local);

  factory GradeEntry.fromRow(Map<String, Object?> r) => GradeEntry(
        id: r['id'] as String,
        studentId: r['student_id'] as String,
        subjectId: r['subject_id'] as String,
        term: r['term'] as String,
        evaluation: r['evaluation'] as String,
        maxScore: (r['max_score'] as num).toDouble(),
        score: (r['score'] as num).toDouble(),
        isSynced: (r['is_synced'] as int) == 1,
        syncError: r['sync_error'] as String?,
      );
}

class OutboxItem {
  const OutboxItem({required this.id, required this.entity, required this.entityId, required this.payload, required this.attempts});
  final int id;
  final String entity;
  final String entityId;
  final String payload;
  final int attempts;

  factory OutboxItem.fromRow(Map<String, Object?> r) => OutboxItem(
        id: r['id'] as int,
        entity: r['entity'] as String,
        entityId: r['entity_id'] as String,
        payload: r['payload'] as String,
        attempts: r['attempts'] as int,
      );
}

class Session {
  const Session({required this.token, required this.userName, required this.role, required this.schoolName});
  final String token;
  final String userName;
  final String role;
  final String schoolName;
}

// =============================================================================
//  Base locale sqflite
// =============================================================================

class LocalDb {
  LocalDb._(this.db);
  final Database db;

  static const entityAttendance = 'attendance';
  static const entityGrade = 'grade';

  static Future<LocalDb> open({DatabaseFactory? factory, String? path}) async {
    final f = factory ?? databaseFactory;
    final dbPath = path ?? p.join(await f.getDatabasesPath(), 'ecole_erp.db');
    final database = await f.openDatabase(
      dbPath,
      options: OpenDatabaseOptions(version: 1, onCreate: (db, _) => _create(db)),
    );
    return LocalDb._(database);
  }

  static Future<void> _create(Database db) async {
    final batch = db.batch();
    batch.execute('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    batch.execute('CREATE TABLE classes (id TEXT PRIMARY KEY, name TEXT NOT NULL, level TEXT NOT NULL, option TEXT)');
    batch.execute('''CREATE TABLE students (
      id TEXT PRIMARY KEY, class_id TEXT NOT NULL, matricule TEXT NOT NULL,
      last_name TEXT NOT NULL, middle_name TEXT, first_name TEXT NOT NULL, sort_order INTEGER NOT NULL)''');
    batch.execute('CREATE INDEX idx_students_class ON students(class_id, sort_order)');
    batch.execute('CREATE TABLE subjects (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_max_score REAL NOT NULL)');
    batch.execute('''CREATE TABLE attendance (
      id TEXT PRIMARY KEY, server_id TEXT, student_id TEXT NOT NULL, class_id TEXT NOT NULL, date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PRESENT','ABSENT')), client_updated_at TEXT NOT NULL,
      is_synced INTEGER NOT NULL DEFAULT 0, sync_error TEXT, sms_status TEXT,
      UNIQUE (student_id, date))''');
    batch.execute('CREATE INDEX idx_attendance_class_date ON attendance(class_id, date)');
    batch.execute('''CREATE TABLE grades (
      id TEXT PRIMARY KEY, server_id TEXT, student_id TEXT NOT NULL, subject_id TEXT NOT NULL, term TEXT NOT NULL,
      evaluation TEXT NOT NULL, max_score REAL NOT NULL, score REAL NOT NULL, client_updated_at TEXT NOT NULL,
      is_synced INTEGER NOT NULL DEFAULT 0, sync_error TEXT,
      UNIQUE (student_id, subject_id, term, evaluation))''');
    // File d'attente des requêtes HTTP : une seule entrée par enregistrement (la plus récente).
    batch.execute('''CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at INTEGER NOT NULL, UNIQUE (entity, entity_id))''');
    await batch.commit(noResult: true);
  }

  Future<void> close() => db.close();

  // ------------------------------------------------------------------ kv
  Future<String?> getKv(String key) async {
    final rows = await db.query('kv', where: 'key = ?', whereArgs: [key], limit: 1);
    return rows.isEmpty ? null : rows.first['value'] as String;
  }

  Future<void> setKv(String key, String value) =>
      db.insert('kv', {'key': key, 'value': value}, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<void> deleteKv(String key) => db.delete('kv', where: 'key = ?', whereArgs: [key]);

  // ------------------------------------------------------- Données de référence
  /// Remplace classes / élèves / matières par la réponse de GET /api/teacher/bootstrap
  /// et fusionne l'appel et les cotes déjà présents côté serveur, sans écraser
  /// les modifications locales encore en attente d'envoi.
  Future<void> applyBootstrap(Map<String, dynamic> data) async {
    await db.transaction((txn) async {
      await txn.delete('students');
      await txn.delete('classes');
      await txn.delete('subjects');
      final batch = txn.batch();
      for (final c in (data['classes'] as List).cast<Map<String, dynamic>>()) {
        batch.insert('classes', {'id': c['id'], 'name': c['name'], 'level': c['level'], 'option': c['option']});
        var order = 0;
        for (final s in (c['students'] as List).cast<Map<String, dynamic>>()) {
          batch.insert('students', {
            'id': s['id'],
            'class_id': c['id'],
            'matricule': s['matricule'],
            'last_name': s['lastName'],
            'middle_name': s['middleName'],
            'first_name': s['firstName'],
            'sort_order': order++,
          });
        }
      }
      for (final s in (data['subjects'] as List).cast<Map<String, dynamic>>()) {
        batch.insert('subjects', {'id': s['id'], 'name': s['name'], 'default_max_score': (s['defaultMaxScore'] as num).toDouble()});
      }
      await batch.commit(noResult: true);

      for (final a in ((data['attendance'] as List?) ?? const []).cast<Map<String, dynamic>>()) {
        final local = await txn.query('attendance', where: 'student_id = ? AND date = ?', whereArgs: [a['studentId'], a['date']], limit: 1);
        if (local.isNotEmpty && (local.first['is_synced'] as int) == 0) continue; // modification locale prioritaire
        await txn.delete('attendance', where: 'student_id = ? AND date = ?', whereArgs: [a['studentId'], a['date']]);
        await txn.insert('attendance', {
          'id': a['id'],
          'server_id': a['id'],
          'student_id': a['studentId'],
          'class_id': a['classId'],
          'date': a['date'],
          'status': a['status'],
          'client_updated_at': a['clientUpdatedAt'],
          'is_synced': 1,
        });
      }
      for (final g in ((data['grades'] as List?) ?? const []).cast<Map<String, dynamic>>()) {
        final where = 'student_id = ? AND subject_id = ? AND term = ? AND evaluation = ?';
        final args = [g['studentId'], g['subjectId'], g['term'], g['evaluation']];
        final local = await txn.query('grades', where: where, whereArgs: args, limit: 1);
        if (local.isNotEmpty && (local.first['is_synced'] as int) == 0) continue;
        await txn.delete('grades', where: where, whereArgs: args);
        await txn.insert('grades', {
          'id': g['id'],
          'server_id': g['id'],
          'student_id': g['studentId'],
          'subject_id': g['subjectId'],
          'term': g['term'],
          'evaluation': g['evaluation'],
          'max_score': (g['maxScore'] as num).toDouble(),
          'score': (g['score'] as num).toDouble(),
          'client_updated_at': g['clientUpdatedAt'],
          'is_synced': 1,
        });
      }
    });
  }

  Future<List<SchoolClass>> classes() async =>
      (await db.query('classes', orderBy: 'name COLLATE NOCASE')).map(SchoolClass.fromRow).toList();

  Future<List<Student>> studentsOfClass(String classId) async =>
      (await db.query('students', where: 'class_id = ?', whereArgs: [classId], orderBy: 'sort_order')).map(Student.fromRow).toList();

  Future<List<Subject>> subjects() async => (await db.query('subjects', orderBy: 'name COLLATE NOCASE')).map(Subject.fromRow).toList();

  // ------------------------------------------------------------------ Appel
  Future<Map<String, AttendanceEntry>> attendanceFor(String classId, String date) async {
    final rows = await db.query('attendance', where: 'class_id = ? AND date = ?', whereArgs: [classId, date]);
    return {for (final r in rows) r['student_id'] as String: AttendanceEntry.fromRow(r)};
  }

  /// Enregistre localement (is_synced = 0) puis place la requête dans la file d'attente.
  Future<AttendanceEntry> saveAttendance({required Student student, required String date, required bool isPresent}) async {
    return db.transaction((txn) async {
      final existing = await txn.query('attendance', where: 'student_id = ? AND date = ?', whereArgs: [student.id, date], limit: 1);
      final id = existing.isEmpty ? newUuid() : existing.first['id'] as String;
      final serverId = existing.isEmpty ? null : existing.first['server_id'] as String?;
      final updatedAt = nowUtcIso();
      final row = {
        'id': id,
        'server_id': serverId,
        'student_id': student.id,
        'class_id': student.classId,
        'date': date,
        'status': isPresent ? 'PRESENT' : 'ABSENT',
        'client_updated_at': updatedAt,
        'is_synced': 0,
        'sync_error': null,
        'sms_status': null,
      };
      await txn.insert('attendance', row, conflictAlgorithm: ConflictAlgorithm.replace);
      await _enqueue(txn, entityAttendance, id, {
        'id': serverId ?? id,
        'studentId': student.id,
        'date': date,
        'isPresent': isPresent,
        'clientUpdatedAt': updatedAt,
      });
      return AttendanceEntry.fromRow(row);
    });
  }

  // ------------------------------------------------------------------ Cotes
  Future<Map<String, GradeEntry>> gradesFor({required String classId, required String subjectId, required String term, required String evaluation}) async {
    final rows = await db.rawQuery(
      'SELECT g.* FROM grades g JOIN students s ON s.id = g.student_id '
      'WHERE s.class_id = ? AND g.subject_id = ? AND g.term = ? AND g.evaluation = ?',
      [classId, subjectId, term, evaluation],
    );
    return {for (final r in rows) r['student_id'] as String: GradeEntry.fromRow(r)};
  }

  Future<GradeEntry> saveGrade({
    required String studentId,
    required String subjectId,
    required String term,
    required String evaluation,
    required double maxScore,
    required double score,
  }) async {
    if (maxScore <= 0) throw ArgumentError('La note maximale doit être positive.');
    if (score < 0 || score > maxScore) throw ArgumentError('La cote doit être comprise entre 0 et ${formatScore(maxScore)}.');
    return db.transaction((txn) async {
      final existing = await txn.query('grades',
          where: 'student_id = ? AND subject_id = ? AND term = ? AND evaluation = ?', whereArgs: [studentId, subjectId, term, evaluation], limit: 1);
      final id = existing.isEmpty ? newUuid() : existing.first['id'] as String;
      final serverId = existing.isEmpty ? null : existing.first['server_id'] as String?;
      final updatedAt = nowUtcIso();
      final row = {
        'id': id,
        'server_id': serverId,
        'student_id': studentId,
        'subject_id': subjectId,
        'term': term,
        'evaluation': evaluation,
        'max_score': maxScore,
        'score': score,
        'client_updated_at': updatedAt,
        'is_synced': 0,
        'sync_error': null,
      };
      await txn.insert('grades', row, conflictAlgorithm: ConflictAlgorithm.replace);
      await _enqueue(txn, entityGrade, id, {
        'id': serverId ?? id,
        'studentId': studentId,
        'subjectId': subjectId,
        'term': term,
        'evaluation': evaluation,
        'maxScore': maxScore,
        'score': score,
        'clientUpdatedAt': updatedAt,
      });
      return GradeEntry.fromRow(row);
    });
  }

  // ------------------------------------------------------------- File d'attente
  Future<void> _enqueue(Transaction txn, String entity, String entityId, Map<String, Object?> payload) async {
    // INSERT OR REPLACE : la dernière version de l'enregistrement remplace la précédente dans la file.
    await txn.insert(
      'outbox',
      {
        'entity': entity,
        'entity_id': entityId,
        'payload': jsonEncode(payload),
        'attempts': 0,
        'next_attempt_at': 0,
        'last_error': null,
        'created_at': DateTime.now().millisecondsSinceEpoch,
      },
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<List<OutboxItem>> dueOutbox(String entity, {required int nowMs, int limit = kSyncBatchSize}) async {
    final rows = await db.query('outbox',
        where: 'entity = ? AND next_attempt_at <= ?', whereArgs: [entity, nowMs], orderBy: 'id', limit: limit);
    return rows.map(OutboxItem.fromRow).toList();
  }

  Future<Map<String, int>> pendingCounts() async {
    final rows = await db.rawQuery('SELECT entity, COUNT(*) AS n FROM outbox GROUP BY entity');
    return {for (final r in rows) r['entity'] as String: (r['n'] as int)};
  }

  Future<int?> nextAttemptAtMs() async {
    final rows = await db.rawQuery('SELECT MIN(next_attempt_at) AS t FROM outbox');
    return rows.first['t'] as int?;
  }

  Future<String?> lastOutboxError() async {
    final rows = await db.query('outbox', columns: ['last_error'], where: 'last_error IS NOT NULL', orderBy: 'id DESC', limit: 1);
    return rows.isEmpty ? null : rows.first['last_error'] as String?;
  }

  String _table(String entity) => entity == entityAttendance ? 'attendance' : 'grades';

  /// Accusé positif : l'entrée n'est retirée de la file (et la ligne marquée synchronisée)
  /// que si elle n'a pas été modifiée pendant l'envoi.
  Future<void> ackSynced(OutboxItem item, {String? serverId, String? smsStatus}) async {
    final payload = jsonDecode(item.payload) as Map<String, dynamic>;
    await db.transaction((txn) async {
      final removed = await txn.delete('outbox', where: 'id = ? AND payload = ?', whereArgs: [item.id, item.payload]);
      if (removed == 0) return; // modifié entre-temps : la nouvelle version partira au prochain cycle
      await txn.update(
        _table(item.entity),
        {'is_synced': 1, 'sync_error': null, 'server_id': ?serverId, if (item.entity == entityAttendance && smsStatus != null) 'sms_status': smsStatus},
        where: 'id = ? AND client_updated_at = ?',
        whereArgs: [item.entityId, payload['clientUpdatedAt']],
      );
    });
  }

  /// Rejet définitif par le serveur (validation) : retiré de la file, erreur affichée sur la ligne.
  Future<void> markRejected(OutboxItem item, String message) async {
    await db.transaction((txn) async {
      final removed = await txn.delete('outbox', where: 'id = ? AND payload = ?', whereArgs: [item.id, item.payload]);
      if (removed == 0) return;
      await txn.update(_table(item.entity), {'sync_error': message, 'is_synced': 0}, where: 'id = ?', whereArgs: [item.entityId]);
    });
  }

  /// Échec temporaire (réseau, 5xx, 429) : nouvelle tentative plus tard.
  Future<void> markRetry(List<OutboxItem> items, String error, int Function(int attempts) delayMs) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final batch = db.batch();
    for (final item in items) {
      final attempts = item.attempts + 1;
      batch.update('outbox', {'attempts': attempts, 'next_attempt_at': now + delayMs(attempts), 'last_error': error},
          where: 'id = ?', whereArgs: [item.id]);
    }
    await batch.commit(noResult: true);
  }

  /// Le réseau revient : on retente immédiatement tout ce qui était en attente de backoff.
  Future<void> resetBackoff() => db.update('outbox', {'next_attempt_at': 0});

  Future<void> clearAll() async {
    await db.transaction((txn) async {
      for (final t in ['outbox', 'attendance', 'grades', 'students', 'classes', 'subjects', 'kv']) {
        await txn.delete(t);
      }
    });
  }
}

// =============================================================================
//  Client HTTP de l'API Node
// =============================================================================

class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message, [this.details]);
  final int statusCode;
  final String code;
  final String message;
  final Object? details;

  /// Erreurs temporaires : la requête sera rejouée plus tard.
  bool get isRetryable => statusCode == 408 || statusCode == 429 || statusCode >= 500;

  @override
  String toString() => 'ApiException($statusCode, $code): $message';
}

class NetworkException implements Exception {
  NetworkException(this.message);
  final String message;
  @override
  String toString() => message;
}

class ApiClient {
  ApiClient({required String baseUrl, http.Client? client, this.timeout = const Duration(seconds: 75)})
      : _client = client ?? http.Client(),
        baseUrl = baseUrl.replaceAll(RegExp(r'/+$'), '');

  final http.Client _client;
  final Duration timeout; // une instance Render gratuite endormie met ~1 min à démarrer
  String baseUrl;
  String? token;

  Future<Map<String, dynamic>> _send(String method, String path, {Object? body}) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{
      'Accept': 'application/json',
      if (body != null) 'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };
    http.Response res;
    try {
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      res = await http.Response.fromStream(await _client.send(req).timeout(timeout));
    } on TimeoutException {
      throw NetworkException('Le serveur ne répond pas (délai dépassé).');
    } on http.ClientException catch (e) {
      throw NetworkException('Serveur injoignable : ${e.message}');
    } on FormatException {
      throw NetworkException('Adresse du serveur invalide : $baseUrl');
    } catch (e) {
      if (e is ApiException) rethrow;
      throw NetworkException('Erreur réseau : $e');
    }

    Map<String, dynamic> json;
    try {
      final decoded = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(utf8.decode(res.bodyBytes));
      json = decoded is Map<String, dynamic> ? decoded : <String, dynamic>{'data': decoded};
    } on FormatException {
      json = <String, dynamic>{};
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      final err = (json['error'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
      throw ApiException(res.statusCode, (err['code'] as String?) ?? 'HTTP_${res.statusCode}',
          (err['message'] as String?) ?? 'Erreur HTTP ${res.statusCode}', err['details']);
    }
    return json;
  }

  Future<Map<String, dynamic>> login(String phone, String password) =>
      _send('POST', '/api/auth/login', body: {'phone': phone, 'password': password});

  Future<Map<String, dynamic>> bootstrap() => _send('GET', '/api/teacher/bootstrap');

  Future<Map<String, dynamic>> syncAttendance(List<Map<String, dynamic>> records) =>
      _send('POST', '/api/attendance/sync', body: {'records': records});

  Future<Map<String, dynamic>> syncGrades(List<Map<String, dynamic>> records) =>
      _send('POST', '/api/grades/sync', body: {'records': records});
}

// =============================================================================
//  Connectivité
// =============================================================================

abstract class ConnectivitySource {
  Future<bool> isOnline();
  Stream<bool> get changes;
}

class PluginConnectivity implements ConnectivitySource {
  final Connectivity _connectivity = Connectivity();

  static bool _hasNetwork(List<ConnectivityResult> results) => results.any((r) => r != ConnectivityResult.none);

  @override
  Future<bool> isOnline() async {
    try {
      return _hasNetwork(await _connectivity.checkConnectivity());
    } catch (_) {
      return true; // en cas de doute, on tente : les erreurs réseau sont gérées par la file
    }
  }

  @override
  Stream<bool> get changes => _connectivity.onConnectivityChanged.map(_hasNetwork).distinct();
}

// =============================================================================
//  Moteur de synchronisation (file d'attente HTTP)
// =============================================================================

class SyncEngine extends ChangeNotifier {
  SyncEngine({required this.db, required this.api, required this.connectivity, this.onUnauthorized, Random? random})
      : _random = random ?? Random();

  final LocalDb db;
  final ApiClient api;
  final ConnectivitySource connectivity;
  final VoidCallback? onUnauthorized;
  final Random _random;

  bool online = false;
  bool serverReachable = true;
  bool syncing = false;
  int pendingAttendance = 0;
  int pendingGrades = 0;
  DateTime? lastSyncAt;
  String? lastError;
  int lastSmsSent = 0;

  StreamSubscription<bool>? _sub;
  Timer? _debounce;
  Timer? _retryTimer;
  Timer? _periodic;
  Future<void>? _running;
  bool _rerun = false;
  bool _disposed = false;
  bool _paused = false;

  int get pendingTotal => pendingAttendance + pendingGrades;

  Future<void> start() async {
    online = await connectivity.isOnline();
    _sub = connectivity.changes.listen((isOnline) async {
      final cameBack = isOnline && !online;
      online = isOnline;
      _notify();
      if (cameBack) {
        await db.resetBackoff();
        unawaited(syncNow());
      }
    });
    _periodic = Timer.periodic(const Duration(minutes: 1), (_) => syncNow());
    await refreshCounts();
    if (online) unawaited(syncNow());
  }

  /// Suspend les envois (session expirée) jusqu'à la prochaine connexion.
  void pause() => _paused = true;
  void resume() {
    _paused = false;
    unawaited(syncNow());
  }

  Future<void> refreshCounts() async {
    final counts = await db.pendingCounts();
    pendingAttendance = counts[LocalDb.entityAttendance] ?? 0;
    pendingGrades = counts[LocalDb.entityGrade] ?? 0;
    _notify();
  }

  /// À appeler après chaque écriture locale : envoi groupé après une courte pause.
  void notifyLocalChange() {
    unawaited(refreshCounts());
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 800), () => syncNow());
  }

  /// Délai de backoff exponentiel plafonné à 15 min, avec gigue.
  int backoffMs(int attempts) {
    final base = 5000 * pow(2, min(attempts - 1, 8)).toInt();
    return min(base, 15 * 60 * 1000) + _random.nextInt(1000);
  }

  Future<void> syncNow() {
    if (_running != null) {
      _rerun = true;
      return _running!;
    }
    final completer = Completer<void>();
    _running = completer.future;
    () async {
      try {
        do {
          _rerun = false;
          await _runOnce();
        } while (_rerun && !_disposed);
      } finally {
        _running = null;
        completer.complete();
      }
    }();
    return completer.future;
  }

  Future<void> _runOnce() async {
    if (_disposed || _paused || api.token == null) return;
    if (!online) {
      await refreshCounts();
      return;
    }
    syncing = true;
    _notify();
    var hadFailure = false;
    try {
      for (final entity in [LocalDb.entityAttendance, LocalDb.entityGrade]) {
        while (!_disposed) {
          final items = await db.dueOutbox(entity, nowMs: DateTime.now().millisecondsSinceEpoch);
          if (items.isEmpty) break;
          final ok = await _sendBatch(entity, items);
          if (!ok) {
            hadFailure = true;
            break;
          }
        }
        if (hadFailure) break;
      }
      if (!hadFailure) {
        lastSyncAt = DateTime.now();
        lastError = null;
      }
    } finally {
      syncing = false;
      await refreshCounts();
      await _scheduleRetry();
    }
  }

  /// Envoie un lot ; renvoie false si l'envoi doit être interrompu (réseau, 401…).
  Future<bool> _sendBatch(String entity, List<OutboxItem> items) async {
    final records = items.map((i) => jsonDecode(i.payload) as Map<String, dynamic>).toList();
    try {
      final res = entity == LocalDb.entityAttendance ? await api.syncAttendance(records) : await api.syncGrades(records);
      serverReachable = true;
      final summary = (res['summary'] as Map?)?.cast<String, dynamic>();
      if (entity == LocalDb.entityAttendance) lastSmsSent = (summary?['smsSent'] as int?) ?? 0;
      final results = ((res['results'] as List?) ?? const []).cast<Map<String, dynamic>>();
      final handled = <int>{};
      for (final r in results) {
        final index = r['index'] as int?;
        if (index == null || index < 0 || index >= items.length) continue;
        handled.add(index);
        if (r['result'] == 'rejected') {
          await db.markRejected(items[index], _errorsText(r['errors']));
        } else {
          await db.ackSynced(items[index], serverId: r['id'] as String?, smsStatus: r['sms'] as String?);
        }
      }
      final missing = [for (var i = 0; i < items.length; i++) if (!handled.contains(i)) items[i]];
      if (missing.isNotEmpty) await db.markRetry(missing, 'Réponse incomplète du serveur', backoffMs);
      return true;
    } on ApiException catch (e) {
      serverReachable = true;
      if (e.statusCode == 401) {
        lastError = 'Session expirée : reconnectez-vous.';
        _paused = true;
        onUnauthorized?.call();
        return false;
      }
      if (e.isRetryable) {
        lastError = e.message;
        await db.markRetry(items, e.message, backoffMs);
        return false;
      }
      // 400 global (aucun enregistrement valide) : détail par index dans error.details
      final details = e.details is List ? (e.details as List).cast<Map<String, dynamic>>() : const <Map<String, dynamic>>[];
      final byIndex = {for (final d in details) if (d['index'] is int) d['index'] as int: d};
      for (var i = 0; i < items.length; i++) {
        await db.markRejected(items[i], byIndex.containsKey(i) ? _errorsText(byIndex[i]!['errors']) : e.message);
      }
      lastError = e.message;
      return true;
    } on NetworkException catch (e) {
      serverReachable = false;
      lastError = e.message;
      await db.markRetry(items, e.message, backoffMs);
      return false;
    }
  }

  String _errorsText(Object? errors) {
    if (errors is List && errors.isNotEmpty) {
      return errors.map((e) => e is Map ? (e['message'] ?? e.toString()) : e.toString()).join(' · ');
    }
    return 'Refusé par le serveur';
  }

  Future<void> _scheduleRetry() async {
    _retryTimer?.cancel();
    if (_disposed) return;
    final next = await db.nextAttemptAtMs();
    if (next == null) return;
    final delay = next - DateTime.now().millisecondsSinceEpoch;
    if (delay <= 0) return; // dû maintenant : le minuteur périodique ou le prochain changement s'en charge
    _retryTimer = Timer(Duration(milliseconds: delay), () => syncNow());
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _sub?.cancel();
    _debounce?.cancel();
    _retryTimer?.cancel();
    _periodic?.cancel();
    super.dispose();
  }
}

// =============================================================================
//  Contrôleur applicatif (session, données de référence)
// =============================================================================

class AppController extends ChangeNotifier {
  AppController({required this.db, required ConnectivitySource connectivity, http.Client? httpClient})
      : api = ApiClient(baseUrl: kDefaultApiUrl, client: httpClient) {
    sync = SyncEngine(db: db, api: api, connectivity: connectivity, onUnauthorized: _onUnauthorized);
  }

  final LocalDb db;
  final ApiClient api;
  late final SyncEngine sync;

  bool ready = false;
  bool sessionExpired = false;
  bool refreshing = false;
  Session? session;
  List<SchoolClass> classes = const [];
  List<Subject> subjects = const [];
  String? selectedClassId;
  String? bootstrapError;

  SchoolClass? get selectedClass => classes.where((c) => c.id == selectedClassId).firstOrNull;

  Future<void> init() async {
    api.baseUrl = (await db.getKv('api_url')) ?? kDefaultApiUrl;
    final token = await db.getKv('token');
    if (token != null) {
      api.token = token;
      session = Session(
        token: token,
        userName: (await db.getKv('user_name')) ?? '',
        role: (await db.getKv('user_role')) ?? 'TEACHER',
        schoolName: (await db.getKv('school_name')) ?? '',
      );
      await _loadLocal();
    }
    await sync.start();
    ready = true;
    notifyListeners();
    if (session != null && sync.online) unawaited(refreshBootstrap());
  }

  Future<void> setApiUrl(String url) async {
    final clean = url.trim().replaceAll(RegExp(r'/+$'), '');
    api.baseUrl = clean;
    await db.setKv('api_url', clean);
    notifyListeners();
  }

  Future<void> _loadLocal() async {
    classes = await db.classes();
    subjects = await db.subjects();
    final saved = await db.getKv('selected_class');
    selectedClassId = classes.any((c) => c.id == saved) ? saved : (classes.isEmpty ? null : classes.first.id);
  }

  /// Connexion. Si un autre compte était utilisé sur l'appareil, ses données locales sont effacées.
  Future<void> login(String phone, String password) async {
    final res = await api.login(phone, password);
    final user = (res['user'] as Map).cast<String, dynamic>();
    final school = (res['school'] as Map).cast<String, dynamic>();
    final previousUser = await db.getKv('user_id');
    if (previousUser != null && previousUser != user['id']) {
      final url = api.baseUrl;
      await db.clearAll();
      await db.setKv('api_url', url);
    }
    final token = res['token'] as String;
    api.token = token;
    await db.setKv('token', token);
    await db.setKv('user_id', user['id'] as String);
    await db.setKv('user_name', user['fullName'] as String);
    await db.setKv('user_role', user['role'] as String);
    await db.setKv('school_name', school['name'] as String);
    session = Session(token: token, userName: user['fullName'] as String, role: user['role'] as String, schoolName: school['name'] as String);
    sessionExpired = false;
    notifyListeners();
    await refreshBootstrap();
    sync.resume();
  }

  /// Télécharge classes, élèves, matières, appel du jour et cotes (GET /api/teacher/bootstrap).
  Future<void> refreshBootstrap() async {
    if (refreshing) return;
    refreshing = true;
    bootstrapError = null;
    notifyListeners();
    try {
      final data = await api.bootstrap();
      await db.applyBootstrap(data);
      await _loadLocal();
    } on ApiException catch (e) {
      if (e.statusCode == 401) {
        _onUnauthorized();
      } else {
        bootstrapError = e.message;
      }
    } on NetworkException catch (e) {
      bootstrapError = classes.isEmpty ? e.message : null; // hors-ligne avec données en cache : silencieux
    } finally {
      refreshing = false;
      notifyListeners();
    }
  }

  Future<void> selectClass(String id) async {
    selectedClassId = id;
    await db.setKv('selected_class', id);
    notifyListeners();
  }

  void _onUnauthorized() {
    sessionExpired = true;
    sync.pause();
    notifyListeners();
  }

  /// Déconnexion : toutes les données locales de l'appareil sont effacées.
  Future<void> logout() async {
    final url = api.baseUrl;
    await db.clearAll();
    await db.setKv('api_url', url);
    api.token = null;
    session = null;
    sessionExpired = false;
    classes = const [];
    subjects = const [];
    selectedClassId = null;
    await sync.refreshCounts();
    notifyListeners();
  }
}

// =============================================================================
//  Interface
// =============================================================================

class EcoleApp extends StatelessWidget {
  const EcoleApp({super.key, required this.controller});
  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(seedColor: kNavy, primary: kNavy, secondary: kNavyLight);
    return MaterialApp(
      title: 'École — Enseignant',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: scheme,
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF5F7FA),
        appBarTheme: const AppBarTheme(backgroundColor: kNavy, foregroundColor: Colors.white, elevation: 0),
        inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder(), isDense: true),
      ),
      home: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          if (!controller.ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
          if (controller.session == null) return LoginScreen(controller: controller);
          return HomeShell(controller: controller);
        },
      ),
    );
  }
}

// ----------------------------------------------------------------- Connexion

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.controller, this.reauth = false});
  final AppController controller;
  final bool reauth;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _password = TextEditingController();
  late final TextEditingController _url = TextEditingController(text: widget.controller.api.baseUrl);
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _password.dispose();
    _url.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (_url.text.trim() != widget.controller.api.baseUrl) await widget.controller.setApiUrl(_url.text);
      await widget.controller.login(_phone.text.trim(), _password.text);
      if (widget.reauth && mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      setState(() => _error = e.statusCode == 401 ? 'Téléphone ou mot de passe incorrect.' : e.message);
    } on NetworkException catch (e) {
      setState(() => _error = '${e.message}\nVérifiez votre connexion (le serveur gratuit peut mettre une minute à se réveiller).');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: kNavy,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                children: [
                  const Icon(Icons.school, color: Colors.white, size: 56),
                  const SizedBox(height: 8),
                  const Text('Espace Enseignant', style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 4),
                  const Text('Appel et cotes, même sans réseau', style: TextStyle(color: Color(0xFFC9D6EA))),
                  const SizedBox(height: 24),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Form(
                        key: _formKey,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            if (widget.reauth)
                              const Padding(
                                padding: EdgeInsets.only(bottom: 12),
                                child: Text('Votre session a expiré. Les données non envoyées sont conservées sur le téléphone.'),
                              ),
                            if (_error != null)
                              Container(
                                margin: const EdgeInsets.only(bottom: 12),
                                padding: const EdgeInsets.all(12),
                                decoration: BoxDecoration(color: const Color(0xFFFDECEC), borderRadius: BorderRadius.circular(8)),
                                child: Text(_error!, style: const TextStyle(color: kAbsentRed)),
                              ),
                            TextFormField(
                              key: const Key('login-phone'),
                              controller: _phone,
                              keyboardType: TextInputType.phone,
                              textInputAction: TextInputAction.next,
                              autofillHints: const [AutofillHints.telephoneNumber],
                              decoration: const InputDecoration(labelText: 'Téléphone', hintText: '0970000002', prefixIcon: Icon(Icons.phone)),
                              validator: (v) => normalizeDrcPhone(v ?? '') == null ? 'Numéro RDC invalide' : null,
                            ),
                            const SizedBox(height: 12),
                            TextFormField(
                              key: const Key('login-password'),
                              controller: _password,
                              obscureText: _obscure,
                              onFieldSubmitted: (_) => _submit(),
                              decoration: InputDecoration(
                                labelText: 'Mot de passe',
                                prefixIcon: const Icon(Icons.lock),
                                suffixIcon: IconButton(
                                  tooltip: _obscure ? 'Afficher' : 'Masquer',
                                  icon: Icon(_obscure ? Icons.visibility : Icons.visibility_off),
                                  onPressed: () => setState(() => _obscure = !_obscure),
                                ),
                              ),
                              validator: (v) => (v ?? '').length < 4 ? 'Mot de passe trop court' : null,
                            ),
                            const SizedBox(height: 8),
                            ExpansionTile(
                              tilePadding: EdgeInsets.zero,
                              title: const Text('Paramètres du serveur', style: TextStyle(fontSize: 14)),
                              children: [
                                TextFormField(
                                  controller: _url,
                                  keyboardType: TextInputType.url,
                                  decoration: const InputDecoration(labelText: 'URL de l’API', hintText: 'https://…onrender.com'),
                                  validator: (v) {
                                    final u = Uri.tryParse((v ?? '').trim());
                                    return u == null || !(u.isScheme('http') || u.isScheme('https')) || u.host.isEmpty ? 'URL invalide' : null;
                                  },
                                ),
                                const SizedBox(height: 8),
                              ],
                            ),
                            const SizedBox(height: 8),
                            FilledButton.icon(
                              key: const Key('login-submit'),
                              onPressed: _busy ? null : _submit,
                              icon: _busy
                                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                                  : const Icon(Icons.login),
                              label: Text(_busy ? 'Connexion…' : 'Se connecter'),
                              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ------------------------------------------------------------------- Accueil

class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.controller});
  final AppController controller;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _tab = 0;
  bool _reauthOpen = false;

  AppController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.addListener(_maybeReauth);
  }

  @override
  void dispose() {
    c.removeListener(_maybeReauth);
    super.dispose();
  }

  void _maybeReauth() {
    if (!c.sessionExpired || _reauthOpen || !mounted) return;
    _reauthOpen = true;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => LoginScreen(controller: c, reauth: true),
      ));
      _reauthOpen = false;
    });
  }

  Future<void> _confirmLogout() async {
    final pending = c.sync.pendingTotal;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Se déconnecter ?'),
        content: Text(pending > 0
            ? '$pending enregistrement(s) ne sont pas encore synchronisés et seront PERDUS. Synchronisez d’abord si possible.'
            : 'Les données locales de ce téléphone seront effacées.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Annuler')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: pending > 0 ? kAbsentRed : kNavy),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Se déconnecter'),
          ),
        ],
      ),
    );
    if (ok == true) await c.logout();
  }

  @override
  Widget build(BuildContext context) {
    final selected = c.selectedClass;
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 12,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(c.session?.schoolName ?? '', style: const TextStyle(fontSize: 12, color: Color(0xFFAFC2DE))),
            if (c.classes.isEmpty)
              const Text('Aucune classe', style: TextStyle(fontSize: 17))
            else
              DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  key: const Key('class-picker'),
                  value: selected?.id,
                  isDense: true,
                  isExpanded: true,
                  dropdownColor: kNavy,
                  iconEnabledColor: Colors.white,
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.white, fontSize: 17, fontWeight: FontWeight.w600),
                  items: [for (final cl in c.classes) DropdownMenuItem(value: cl.id, child: Text(cl.name, overflow: TextOverflow.ellipsis))],
                  onChanged: (id) => id == null ? null : c.selectClass(id),
                ),
              ),
          ],
        ),
        actions: [
          SyncIndicator(engine: c.sync, onTap: () => showSyncSheet(context, c)),
          PopupMenuButton<String>(
            tooltip: 'Menu',
            onSelected: (v) {
              if (v == 'refresh') c.refreshBootstrap();
              if (v == 'logout') _confirmLogout();
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'refresh', child: ListTile(leading: Icon(Icons.download), title: Text('Recharger les listes'))),
              PopupMenuItem(value: 'logout', child: ListTile(leading: Icon(Icons.logout), title: Text('Se déconnecter'))),
            ],
          ),
        ],
      ),
      body: Column(
        children: [
          if (c.refreshing) const LinearProgressIndicator(minHeight: 2),
          if (c.bootstrapError != null)
            MaterialBanner(
              content: Text(c.bootstrapError!),
              leading: const Icon(Icons.wifi_off, color: kAbsentRed),
              actions: [TextButton(onPressed: c.refreshBootstrap, child: const Text('Réessayer'))],
            ),
          Expanded(
            child: selected == null
                ? EmptyState(
                    icon: Icons.class_,
                    title: c.refreshing ? 'Chargement…' : 'Aucune classe disponible',
                    message: 'Connectez-vous à Internet puis touchez « Recharger les listes ».',
                  )
                : IndexedStack(
                    index: _tab,
                    children: [
                      AttendanceScreen(key: ValueKey('att-${selected.id}'), controller: c, schoolClass: selected),
                      GradesScreen(key: ValueKey('grd-${selected.id}'), controller: c, schoolClass: selected),
                    ],
                  ),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.fact_check_outlined), selectedIcon: Icon(Icons.fact_check), label: 'Appel'),
          NavigationDestination(icon: Icon(Icons.edit_note_outlined), selectedIcon: Icon(Icons.edit_note), label: 'Cotes'),
        ],
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, required this.message});
  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 48, color: kGrey),
          const SizedBox(height: 12),
          Text(title, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600), textAlign: TextAlign.center),
          const SizedBox(height: 6),
          Text(message, style: const TextStyle(color: kGrey), textAlign: TextAlign.center),
        ]),
      ),
    );
  }
}

// --------------------------------------------------- Indicateurs de synchronisation

/// Icône d'état d'un enregistrement : nuage orange (local), coche verte (cloud), erreur rouge.
class SyncStatusIcon extends StatelessWidget {
  const SyncStatusIcon({super.key, required this.state, this.error});
  final SyncState? state;
  final String? error;

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color color, String label) = switch (state) {
      null => (Icons.radio_button_unchecked, const Color(0xFFCBD5E1), 'Non saisi'),
      SyncState.local => (Icons.cloud_upload, kPendingOrange, 'Enregistré sur le téléphone, en attente d’envoi'),
      SyncState.synced => (Icons.check_circle, kPresentGreen, 'Synchronisé avec le serveur'),
      SyncState.error => (Icons.error, kAbsentRed, 'Refusé : ${error ?? ''}'),
    };
    return Tooltip(
      message: label,
      child: Semantics(label: label, child: Icon(icon, color: color, size: 22, key: ValueKey('sync-${state?.name ?? 'none'}'))),
    );
  }
}

class SyncIndicator extends StatelessWidget {
  const SyncIndicator({super.key, required this.engine, required this.onTap});
  final SyncEngine engine;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: engine,
      builder: (context, _) {
        final pending = engine.pendingTotal;
        final IconData icon;
        final Color color;
        final String label;
        if (!engine.online) {
          icon = Icons.cloud_off;
          color = kPendingOrange;
          label = 'Hors ligne';
        } else if (engine.syncing) {
          icon = Icons.sync;
          color = Colors.white;
          label = 'Envoi…';
        } else if (pending > 0) {
          icon = Icons.cloud_upload;
          color = kPendingOrange;
          label = engine.serverReachable ? 'En attente' : 'Serveur injoignable';
        } else {
          icon = Icons.cloud_done;
          color = const Color(0xFF6EE7A0);
          label = 'À jour';
        }
        return InkWell(
          key: const Key('sync-indicator'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(20),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, color: color, size: 22),
              const SizedBox(width: 4),
              Text(pending > 0 ? '$pending' : label, style: TextStyle(color: color, fontWeight: FontWeight.w600, fontSize: 13)),
            ]),
          ),
        );
      },
    );
  }
}

Future<void> showSyncSheet(BuildContext context, AppController c) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => ListenableBuilder(
      listenable: c.sync,
      builder: (ctx, _) {
        final s = c.sync;
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Synchronisation', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                const SizedBox(height: 12),
                _SheetRow(icon: s.online ? Icons.wifi : Icons.wifi_off, label: 'Réseau', value: s.online ? 'Connecté' : 'Hors ligne'),
                _SheetRow(icon: Icons.fact_check, label: 'Présences en attente', value: '${s.pendingAttendance}'),
                _SheetRow(icon: Icons.edit_note, label: 'Cotes en attente', value: '${s.pendingGrades}'),
                _SheetRow(icon: Icons.schedule, label: 'Dernière synchronisation', value: s.lastSyncAt == null ? '—' : formatTime(s.lastSyncAt!)),
                _SheetRow(icon: Icons.sms, label: 'SMS d’absence (dernier envoi)', value: '${s.lastSmsSent}'),
                if (s.lastError != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text('Dernière erreur : ${s.lastError}', style: const TextStyle(color: kAbsentRed)),
                  ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: s.syncing || !s.online
                      ? null
                      : () async {
                          await c.db.resetBackoff();
                          await s.syncNow();
                        },
                  icon: const Icon(Icons.sync),
                  label: Text(s.syncing ? 'Synchronisation…' : 'Synchroniser maintenant'),
                ),
              ],
            ),
          ),
        );
      },
    ),
  );
}

class _SheetRow extends StatelessWidget {
  const _SheetRow({required this.icon, required this.label, required this.value});
  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(children: [
          Icon(icon, size: 20, color: kGrey),
          const SizedBox(width: 12),
          Expanded(child: Text(label)),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w600)),
        ]),
      );
}

// --------------------------------------------------------------------- Appel

class AttendanceScreen extends StatefulWidget {
  const AttendanceScreen({super.key, required this.controller, required this.schoolClass});
  final AppController controller;
  final SchoolClass schoolClass;

  @override
  State<AttendanceScreen> createState() => _AttendanceScreenState();
}

class _AttendanceScreenState extends State<AttendanceScreen> {
  String _date = isoDate(DateTime.now());
  List<Student> _students = const [];
  Map<String, AttendanceEntry> _entries = const {};
  bool _loading = true;

  LocalDb get db => widget.controller.db;
  SyncEngine get sync => widget.controller.sync;

  @override
  void initState() {
    super.initState();
    sync.addListener(_reload);
    widget.controller.addListener(_reload);
    _reload();
  }

  @override
  void dispose() {
    sync.removeListener(_reload);
    widget.controller.removeListener(_reload);
    super.dispose();
  }

  Future<void> _reload() async {
    final students = await db.studentsOfClass(widget.schoolClass.id);
    final entries = await db.attendanceFor(widget.schoolClass.id, _date);
    if (!mounted) return;
    setState(() {
      _students = students;
      _entries = entries;
      _loading = false;
    });
  }

  Future<void> _set(Student s, bool isPresent) async {
    final entry = await db.saveAttendance(student: s, date: _date, isPresent: isPresent);
    if (!mounted) return;
    setState(() => _entries = {..._entries, s.id: entry});
    sync.notifyLocalChange();
  }

  Future<void> _markRemainingPresent() async {
    final remaining = _students.where((s) => !_entries.containsKey(s.id)).toList();
    for (final s in remaining) {
      await db.saveAttendance(student: s, date: _date, isPresent: true);
    }
    await _reload();
    sync.notifyLocalChange();
  }

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: parseIsoDate(_date),
      firstDate: now.subtract(const Duration(days: kMaxPastDays)),
      lastDate: now,
      helpText: 'Date de l’appel',
    );
    if (picked == null) return;
    setState(() {
      _date = isoDate(picked);
      _loading = true;
    });
    await _reload();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final present = _entries.values.where((e) => e.isPresent).length;
    final absent = _entries.values.where((e) => !e.isPresent).length;
    final remaining = _students.length - _entries.length;
    final local = _entries.values.where((e) => e.state == SyncState.local).length;

    return Column(
      children: [
        Material(
          color: Colors.white,
          elevation: 1,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(children: [
                  Expanded(
                    child: InkWell(
                      onTap: _pickDate,
                      child: Row(children: [
                        const Icon(Icons.event, size: 20, color: kNavy),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(formatDateFr(_date),
                              overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600, color: kNavy)),
                        ),
                        const Icon(Icons.arrow_drop_down, color: kNavy),
                      ]),
                    ),
                  ),
                  if (local > 0)
                    Row(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(Icons.cloud_upload, color: kPendingOrange, size: 18),
                      const SizedBox(width: 4),
                      Text('$local local', style: const TextStyle(color: kPendingOrange, fontSize: 12, fontWeight: FontWeight.w600)),
                    ]),
                ]),
                const SizedBox(height: 10),
                Row(children: [
                  _CountChip(label: 'Présents', value: present, color: kPresentGreen),
                  const SizedBox(width: 8),
                  _CountChip(label: 'Absents', value: absent, color: kAbsentRed),
                  const SizedBox(width: 8),
                  _CountChip(label: 'Non pointés', value: remaining, color: kGrey),
                ]),
                if (remaining > 0) ...[
                  const SizedBox(height: 10),
                  OutlinedButton.icon(
                    key: const Key('mark-all-present'),
                    onPressed: _markRemainingPresent,
                    icon: const Icon(Icons.done_all),
                    label: Text('Marquer les $remaining restants présents'),
                  ),
                ],
              ],
            ),
          ),
        ),
        Expanded(
          child: _students.isEmpty
              ? const EmptyState(icon: Icons.people_outline, title: 'Aucun élève', message: 'Cette classe ne contient aucun élève actif.')
              : ListView.separated(
                  padding: const EdgeInsets.only(bottom: 24),
                  itemCount: _students.length,
                  separatorBuilder: (_, _) => const Divider(height: 1, indent: 72),
                  itemBuilder: (context, i) {
                    final s = _students[i];
                    final e = _entries[s.id];
                    return AttendanceTile(student: s, entry: e, onChanged: (v) => _set(s, v));
                  },
                ),
        ),
      ],
    );
  }
}

class _CountChip extends StatelessWidget {
  const _CountChip({required this.label, required this.value, required this.color});
  final String label;
  final int value;
  final Color color;

  @override
  Widget build(BuildContext context) => Expanded(
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 6),
          decoration: BoxDecoration(color: color.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(10)),
          child: Column(children: [
            Text('$value', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: color)),
            FittedBox(fit: BoxFit.scaleDown, child: Text(label, style: TextStyle(fontSize: 12, color: color))),
          ]),
        ),
      );
}

class AttendanceTile extends StatelessWidget {
  const AttendanceTile({super.key, required this.student, required this.entry, required this.onChanged});
  final Student student;
  final AttendanceEntry? entry;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final marked = entry != null;
    final isPresent = entry?.isPresent ?? true;
    final statusColor = !marked ? kGrey : (isPresent ? kPresentGreen : kAbsentRed);
    final statusText = !marked ? 'Non pointé' : (isPresent ? 'Présent' : 'Absent');
    final sms = entry?.smsStatus == 'sent' || entry?.smsStatus == 'already_sent';

    return ListTile(
      key: ValueKey('student-${student.id}'),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      leading: CircleAvatar(
        backgroundColor: statusColor.withValues(alpha: 0.12),
        foregroundColor: statusColor,
        child: Text(student.initials, style: const TextStyle(fontWeight: FontWeight.bold)),
      ),
      title: Text(student.fullName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: Text.rich(
        TextSpan(children: [
          TextSpan(text: statusText, style: TextStyle(color: statusColor, fontWeight: FontWeight.w600)),
          TextSpan(text: ' · ${student.matricule}'),
          if (sms) const TextSpan(text: ' · SMS envoyé', style: TextStyle(color: kPresentGreen)),
          if (entry?.syncError != null) TextSpan(text: '\n${entry!.syncError}', style: const TextStyle(color: kAbsentRed)),
        ]),
        style: const TextStyle(fontSize: 12),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SyncStatusIcon(state: entry?.state, error: entry?.syncError),
          const SizedBox(width: 4),
          Semantics(
            label: '${student.fullName} : $statusText',
            child: Switch(
              key: ValueKey('switch-${student.id}'),
              value: isPresent,
              onChanged: onChanged,
              thumbColor: WidgetStateProperty.all(Colors.white),
              trackColor: WidgetStateProperty.resolveWith(
                (states) => !marked ? const Color(0xFFCBD5E1) : (states.contains(WidgetState.selected) ? kPresentGreen : kAbsentRed),
              ),
              trackOutlineColor: WidgetStateProperty.all(Colors.transparent),
            ),
          ),
        ],
      ),
      onTap: () => onChanged(!marked ? true : !isPresent),
    );
  }
}

// --------------------------------------------------------------------- Cotes

class GradesScreen extends StatefulWidget {
  const GradesScreen({super.key, required this.controller, required this.schoolClass});
  final AppController controller;
  final SchoolClass schoolClass;

  @override
  State<GradesScreen> createState() => _GradesScreenState();
}

class _GradesScreenState extends State<GradesScreen> {
  String? _subjectId;
  String _term = 'T1';
  String _evaluation = kEvaluations.first;
  final _maxCtrl = TextEditingController(text: '20');
  List<Student> _students = const [];
  Map<String, GradeEntry> _grades = const {};
  final Map<String, TextEditingController> _ctrls = {};
  final Map<String, FocusNode> _focus = {};
  final Map<String, String?> _errors = {};
  bool _loading = true;

  LocalDb get db => widget.controller.db;
  SyncEngine get sync => widget.controller.sync;
  List<Subject> get subjects => widget.controller.subjects;

  @override
  void initState() {
    super.initState();
    _subjectId = subjects.isEmpty ? null : subjects.first.id;
    if (subjects.isNotEmpty) _maxCtrl.text = formatScore(subjects.first.defaultMaxScore);
    sync.addListener(_refreshStatuses);
    _load(resetFields: true);
  }

  @override
  void dispose() {
    sync.removeListener(_refreshStatuses);
    for (final c in _ctrls.values) {
      c.dispose();
    }
    for (final f in _focus.values) {
      f.dispose();
    }
    _maxCtrl.dispose();
    super.dispose();
  }

  double? get _maxScore {
    final v = parseScore(_maxCtrl.text);
    return v != null && v > 0 && v <= 1000 ? v : null;
  }

  Future<void> _load({required bool resetFields}) async {
    final students = await db.studentsOfClass(widget.schoolClass.id);
    final grades = _subjectId == null
        ? <String, GradeEntry>{}
        : await db.gradesFor(classId: widget.schoolClass.id, subjectId: _subjectId!, term: _term, evaluation: _evaluation);
    if (!mounted) return;
    setState(() {
      _students = students;
      _grades = grades;
      _loading = false;
      for (final s in students) {
        _ctrls.putIfAbsent(s.id, TextEditingController.new);
        _focus.putIfAbsent(s.id, () {
          final node = FocusNode();
          node.addListener(() {
            if (!node.hasFocus) _save(s, moveNext: false);
          });
          return node;
        });
      }
      if (resetFields) {
        _errors.clear();
        for (final s in students) {
          final g = grades[s.id];
          _ctrls[s.id]!.text = g == null ? '' : formatScore(g.score);
        }
        if (grades.isNotEmpty) _maxCtrl.text = formatScore(grades.values.first.maxScore);
      }
    });
  }

  /// Après une synchronisation, seules les icônes d'état changent (on ne touche pas aux saisies en cours).
  Future<void> _refreshStatuses() async {
    if (_subjectId == null) return;
    final grades = await db.gradesFor(classId: widget.schoolClass.id, subjectId: _subjectId!, term: _term, evaluation: _evaluation);
    if (mounted) setState(() => _grades = grades);
  }

  void _changeSelection({String? subjectId, String? term, String? evaluation}) {
    setState(() {
      if (subjectId != null) {
        _subjectId = subjectId;
        final subject = subjects.firstWhere((s) => s.id == subjectId);
        _maxCtrl.text = formatScore(subject.defaultMaxScore);
      }
      if (term != null) _term = term;
      if (evaluation != null) _evaluation = evaluation;
    });
    _load(resetFields: true);
  }

  Future<void> _save(Student s, {required bool moveNext}) async {
    final text = _ctrls[s.id]!.text;
    final existing = _grades[s.id];
    final max = _maxScore;
    String? error;
    final score = parseScore(text);
    if (text.trim().isEmpty) {
      error = null;
    } else if (max == null) {
      error = 'Note max invalide';
    } else if (score == null) {
      error = 'Nombre attendu';
    } else if (score < 0 || score > max) {
      error = '0 à ${formatScore(max)}';
    }

    if (error == null && score != null && max != null && _subjectId != null) {
      final unchanged = existing != null && existing.score == score && existing.maxScore == max;
      if (!unchanged) {
        final g = await db.saveGrade(
            studentId: s.id, subjectId: _subjectId!, term: _term, evaluation: _evaluation, maxScore: max, score: score);
        if (!mounted) return;
        _grades = {..._grades, s.id: g};
        sync.notifyLocalChange();
      }
    }
    if (!mounted) return;
    setState(() => _errors[s.id] = error);
    if (moveNext && error == null) {
      final i = _students.indexWhere((x) => x.id == s.id);
      if (i >= 0 && i + 1 < _students.length) {
        _focus[_students[i + 1].id]!.requestFocus();
      } else {
        FocusScope.of(context).unfocus();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (subjects.isEmpty) {
      return const EmptyState(icon: Icons.menu_book, title: 'Aucune matière', message: 'Rechargez les listes une fois connecté.');
    }
    if (_loading) return const Center(child: CircularProgressIndicator());

    final scores = _grades.values.map((g) => g.score / g.maxScore).toList();
    final average = scores.isEmpty ? null : scores.reduce((a, b) => a + b) / scores.length;
    final max = _maxScore;

    return Column(
      children: [
        Material(
          color: Colors.white,
          elevation: 1,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
            child: Column(children: [
              Row(children: [
                Expanded(
                  flex: 3,
                  child: DropdownButtonFormField<String>(
                    key: const Key('subject-picker'),
                    initialValue: _subjectId,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Matière'),
                    items: [for (final s in subjects) DropdownMenuItem(value: s.id, child: Text(s.name, overflow: TextOverflow.ellipsis))],
                    onChanged: (v) => v == null ? null : _changeSelection(subjectId: v),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 84,
                  child: TextField(
                    key: const Key('max-score'),
                    controller: _maxCtrl,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]'))],
                    decoration: InputDecoration(labelText: 'Max', errorText: max == null ? '!' : null),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
              ]),
              const SizedBox(height: 8),
              Row(children: [
                SegmentedButton<String>(
                  segments: [for (final t in kTerms) ButtonSegment(value: t, label: Text(t))],
                  selected: {_term},
                  showSelectedIcon: false,
                  style: const ButtonStyle(visualDensity: VisualDensity.compact),
                  onSelectionChanged: (s) => _changeSelection(term: s.first),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButtonFormField<String>(
                    key: const Key('evaluation-picker'),
                    initialValue: _evaluation,
                    isExpanded: true,
                    decoration: const InputDecoration(labelText: 'Évaluation'),
                    items: [for (final e in kEvaluations) DropdownMenuItem(value: e, child: Text(e, overflow: TextOverflow.ellipsis))],
                    onChanged: (v) => v == null ? null : _changeSelection(evaluation: v),
                  ),
                ),
              ]),
              const SizedBox(height: 6),
              Row(children: [
                Text('${_grades.length}/${_students.length} saisies', style: const TextStyle(color: kGrey, fontSize: 12)),
                const Spacer(),
                Text(
                  average == null ? 'Moyenne : —' : 'Moyenne : ${formatScore(double.parse((average * (max ?? 20)).toStringAsFixed(2)))}/${formatScore(max ?? 20)}',
                  style: const TextStyle(color: kNavy, fontSize: 12, fontWeight: FontWeight.w600),
                ),
              ]),
            ]),
          ),
        ),
        Container(
          color: const Color(0xFFEEF1F5),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: const Row(children: [
            SizedBox(width: 28, child: Text('N°', style: _headStyle)),
            Expanded(child: Text('ÉLÈVE', style: _headStyle)),
            SizedBox(width: 96, child: Text('COTE', style: _headStyle, textAlign: TextAlign.center)),
            SizedBox(width: 30),
          ]),
        ),
        Expanded(
          child: ListView.separated(
            padding: const EdgeInsets.only(bottom: 120),
            itemCount: _students.length,
            separatorBuilder: (_, _) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final s = _students[i];
              final g = _grades[s.id];
              final error = _errors[s.id];
              final isLast = i == _students.length - 1;
              return Padding(
                key: ValueKey('grade-row-${s.id}'),
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
                child: Row(children: [
                  SizedBox(width: 28, child: Text('${i + 1}', style: const TextStyle(color: kGrey))),
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(s.fullName, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text(g?.syncError ?? s.matricule,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11, color: g?.syncError != null ? kAbsentRed : kGrey)),
                    ]),
                  ),
                  SizedBox(
                    width: 96,
                    child: TextField(
                      key: ValueKey('score-${s.id}'),
                      controller: _ctrls[s.id],
                      focusNode: _focus[s.id],
                      textAlign: TextAlign.center,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      textInputAction: isLast ? TextInputAction.done : TextInputAction.next,
                      inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.,]')), LengthLimitingTextInputFormatter(6)],
                      decoration: InputDecoration(
                        hintText: '—',
                        suffixText: '/${formatScore(max ?? 0)}',
                        errorText: error,
                        errorMaxLines: 1,
                        contentPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
                      ),
                      onSubmitted: (_) => _save(s, moveNext: true),
                    ),
                  ),
                  const SizedBox(width: 6),
                  SizedBox(width: 24, child: SyncStatusIcon(state: g?.state, error: g?.syncError)),
                ]),
              );
            },
          ),
        ),
      ],
    );
  }
}

const TextStyle _headStyle = TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: kGrey, letterSpacing: 0.4);

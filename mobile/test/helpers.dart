import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ecole_mobile/main.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

const classId = '11111111-1111-4111-8111-111111111111';
const subjectId = '22222222-2222-4222-8222-222222222222';
const studentIds = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-0000-4000-8000-000000000003',
];

Map<String, dynamic> bootstrapJson({List<Map<String, dynamic>> attendance = const [], List<Map<String, dynamic>> grades = const []}) => {
      'success': true,
      'serverDate': isoDate(DateTime.now()),
      'classes': [
        {
          'id': classId,
          'name': '5e Primaire A',
          'level': '5e Primaire',
          'option': null,
          'students': [
            {'id': studentIds[0], 'matricule': 'MWG-001', 'lastName': 'Kahindo', 'middleName': 'Masika', 'firstName': 'Grâce'},
            {'id': studentIds[1], 'matricule': 'MWG-002', 'lastName': 'Kambale', 'middleName': 'Paluku', 'firstName': 'Josué'},
            {'id': studentIds[2], 'matricule': 'MWG-003', 'lastName': 'Mumbere', 'middleName': 'Siwako', 'firstName': 'Daniel'},
          ],
        },
      ],
      'subjects': [
        {'id': subjectId, 'name': 'Mathématiques', 'defaultMaxScore': 20},
      ],
      'attendance': attendance,
      'grades': grades,
    };

class FakeConnectivity implements ConnectivitySource {
  FakeConnectivity({this.online = true});
  bool online;
  final _ctrl = StreamController<bool>.broadcast();

  @override
  Future<bool> isOnline() async => online;

  @override
  Stream<bool> get changes => _ctrl.stream;

  void set(bool value) {
    online = value;
    _ctrl.add(value);
  }
}

/// Faux serveur Node : renvoie un accusé par enregistrement (format réel de l'API).
class FakeServer {
  final List<http.Request> requests = [];
  http.Response Function(http.Request req)? override;
  Completer<void>? gate;

  List<Map<String, dynamic>> recordsOf(int i) =>
      ((jsonDecode(requests[i].body) as Map)['records'] as List).cast<Map<String, dynamic>>();

  late final MockClient client = MockClient((req) async {
    requests.add(req);
    if (gate != null) await gate!.future;
    if (override != null) return override!(req);
    if (req.url.path == '/api/teacher/bootstrap') return _json(200, bootstrapJson());
    if (req.url.path == '/api/auth/login') {
      return _json(200, {
        'token': 'jeton-test',
        'user': {'id': 'u1', 'fullName': 'Kambale Jean', 'role': 'TEACHER', 'phone': '+243970000002'},
        'school': {'id': 's1', 'name': 'Institut Mwanga'},
      });
    }
    final records = ((jsonDecode(req.body) as Map)['records'] as List).cast<Map<String, dynamic>>();
    final results = [
      for (var i = 0; i < records.length; i++)
        {
          'index': i,
          'clientId': records[i]['id'],
          'id': records[i]['id'],
          'result': 'created',
          if (req.url.path == '/api/attendance/sync') 'sms': records[i]['isPresent'] == false ? 'sent' : 'not_required',
        },
    ];
    return _json(200, {
      'success': true,
      'summary': {'received': records.length, 'saved': records.length, 'smsSent': records.where((r) => r['isPresent'] == false).length},
      'results': results,
    });
  });
}

http.Response _json(int status, Object body) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json; charset=utf-8'});

http.Response jsonResponse(int status, Object body) => _json(status, body);

Future<LocalDb> openTestDb() async {
  sqfliteFfiInit();
  final dir = await Directory.systemTemp.createTemp('ecole_test_');
  return LocalDb.open(factory: databaseFactoryFfi, path: '${dir.path}/test.db');
}

Future<List<Student>> seedLocal(LocalDb db) async {
  await db.applyBootstrap(bootstrapJson());
  return db.studentsOfClass(classId);
}

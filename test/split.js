/**
 * Testes do divisor 3MF: ZIP, XML, paint_color, transformações e exportação.
 *
 *   node test/split.js
 */
'use strict';

const Split = require('../src/split/3mf.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  \u2713 ' + name);
  } else {
    failed++;
    failures.push(name + (detail ? ' -> ' + detail : ''));
    console.log('  \u2717 ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

function asBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const MAIN = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources>
    <object id="2" type="model">
      <components>
        <component p:path="/3D/Objects/o.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>
      </components>
    </object>
  </resources>
  <build>
    <item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>
  </build>
</model>`;

function objectModel(paint) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          <vertex x="0" y="0" z="0"/>
          <vertex x="1" y="0" z="0"/>
          <vertex x="0" y="1" z="0"/>
          <vertex x="1" y="1" z="0"/>
        </vertices>
        <triangles>
          <triangle v1="0" v2="1" v3="2"${paint ? ' paint_color="8"' : ''}/>
          <triangle v1="1" v2="3" v3="2"${paint ? ' paint_color="8"' : ''}/>
          <triangle v1="0" v2="2" v3="3"/>
        </triangles>
      </mesh>
    </object>
  </resources>
</model>`;
}

function fixture(paint) {
  return Split.zipFiles([
    { name: '3D/3dmodel.model', data: MAIN },
    { name: '3D/Objects/o.model', data: objectModel(paint) },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ filament_colour: ['#FFFFFF', '#80FF00'] }) }
  ]);
}

async function main() {
  section('3MF: leitura e paint_color');
  const parsed = await Split.parse(asBuffer(fixture(true)), { applyTransforms: true });
  check('abre o 3MF pelo ZIP', parsed.groups.length === 2, String(parsed.groups.length));
  check('triângulos totais', parsed.triangles === 3, String(parsed.triangles));
  check('objeto resolvido via componente', parsed.objects === 1, String(parsed.objects));
  check('grupo paint_color_0 existe', parsed.groups[0].id === '0' && parsed.groups[0].triangles === 1);
  check('grupo paint_color_8 existe', parsed.groups[1].id === '8' && parsed.groups[1].triangles === 2);
  check('cores dos filamentos', parsed.colors.join(',') === '#FFFFFF,#80FF00', parsed.colors.join(','));
  check('cor do grupo 8', parsed.groups[1].color === '#80FF00', parsed.groups[1].color);

  section('3MF: transformações');
  check('build + componente aplicados', Math.abs(parsed.groups[1].positions[0] - 12) < 1e-6,
    String(parsed.groups[1].positions[0]));
  check('tamanho após transformação', parsed.size.join(',') === '1,1,0', parsed.size.join(','));
  const raw = await Split.parse(asBuffer(fixture(true)), { applyTransforms: false });
  check('transformações desligadas', Math.abs(raw.groups[1].positions[0]) < 1e-6,
    String(raw.groups[1].positions[0]));

  section('3MF: exportação STL/OBJ/PLY');
  const stl = Split.stlBinary(parsed.groups[1]);
  check('STL tem 84 + 50 * triângulos bytes', stl.length === 84 + 50 * 2, String(stl.length));
  const stlView = new DataView(stl.buffer);
  check('STL declara 2 triângulos', stlView.getUint32(80, true) === 2);
  const obj = Split.objText(parsed.groups[1]);
  check('OBJ tem 2 faces', obj.split('\n').filter((line) => line.startsWith('f ')).length === 2);
  check('OBJ declara o grupo', obj.indexOf('o paint_color_8') !== -1);
  const ply = Split.plyText(parsed.groups[1]);
  check('PLY tem cabeçalho ASCII', ply.startsWith('ply\nformat ascii 1.0'));
  check('PLY declara 2 faces', ply.indexOf('element face 2') !== -1);

  section('3MF: STL único com partes separadas');
  const single = Split.exportSingleStl(parsed.groups, 'teste.3mf');
  check('STL único tem nome .stl', single.name === 'teste_partes.stl', single.name);
  const solids = (single.data.match(/^solid /gm) || []).length;
  check('STL único tem um solid por grupo', solids === 2, String(solids));
  check('STL único mantém paint_color_0', single.data.indexOf('solid paint_color_0') !== -1);
  check('STL único mantém paint_color_8', single.data.indexOf('solid paint_color_8') !== -1);
  const facets = (single.data.match(/facet normal/g) || []).length;
  check('STL único tem todos os 3 triângulos', facets === 3, String(facets));
  check('STL único é ASCII', single.data.indexOf('endsolid paint_color_8') !== -1);

  section('3MF: ZIP de saída');
  const zip = Split.zipFiles(parsed.groups.map((group) => Split.exportGroup(group, 'stl', 'teste.3mf')));
  check('ZIP começa com PK\\x03\\x04', zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 3 && zip[3] === 4);
  const entries = Split.readZipEntries(asBuffer(zip));
  check('ZIP tem os dois STLs', Object.keys(entries).length === 2, Object.keys(entries).join(','));
  check('nome do STL do grupo 8', Object.keys(entries).some((name) => name === 'teste_paint_color_8.stl'));

  section('3MF: sem paint_color e erro');
  const noPaint = await Split.parse(asBuffer(fixture(false)), { applyTransforms: false });
  check('sem pintura vira um único grupo 0', noPaint.groups.length === 1 && noPaint.groups[0].id === '0');
  check('sem pintura mantém 3 triângulos', noPaint.groups[0].triangles === 3);
  check('aviso de ausência de paint_color', noPaint.warnings.some((warning) => warning.indexOf('paint_color') !== -1));
  let rejected = false;
  try {
    await Split.parse(new ArrayBuffer(20), {});
  } catch (error) {
    rejected = true;
  }
  check('arquivo inválido é recusado', rejected);

  console.log('\n' + passed + ' passaram, ' + failed + ' falharam');
  if (failed) {
    console.log(failures.join('\n'));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

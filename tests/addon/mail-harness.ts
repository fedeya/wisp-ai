import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import {
  decodeFrame,
  FIRST,
  LAST,
  MailboxDecoder,
  UPLINK_KIND,
  inflateMessage,
} from '../../packages/protocol/src/mailbox.ts';
import { packetSchema } from '../../packages/protocol/src/protocol.ts';

const require = createRequire(import.meta.url);
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

// Synthetic public cache only. Real production reader, Inspect, Send and framing.
export function mailHarness() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const run = (source: string) => {
    if (lauxlib.luaL_dostring(L, to_luastring(source)) !== lua.LUA_OK) {
      throw Error(to_jsstring(lua.lua_tolstring(L, -1)));
    }
  };
  const string = (name: string) => {
    lua.lua_getglobal(L, to_luastring(name));
    const result = Buffer.from(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return result;
  };
  run(readFileSync('addon/tests/fixtures/transport.lua', 'utf8'));
  lua.lua_pushcfunction(L, () => {
    const text = Buffer.from(lua.lua_tolstring(L, 1));
    const compressed = deflateSync(text);
    lua.lua_pushlstring(L, compressed, compressed.length);
    return 1;
  });
  lua.lua_setglobal(L, to_luastring('compress'));
  run(String.raw`
local function quote(s)
 return '"'..s:gsub('[%z\1-\31\\"]',function(c)
  if c=='"' then return '\\"' elseif c=='\\' then return '\\\\' end
  return string.format('\\u%04x',string.byte(c))
 end)..'"'
end
local function json(v)
 if type(v)=='string' then return quote(v) end
 if type(v)=='number' or type(v)=='boolean' then return tostring(v) end
 assert(type(v)=='table')
 local a={}
 if #v>0 then for _,x in ipairs(v)do a[#a+1]=json(x)end;return '['..table.concat(a,',')..']' end
 for k,x in pairs(v)do a[#a+1]=quote(k)..':'..json(x)end
 table.sort(a);return '{'..table.concat(a,',')..'}'
end
C_EncodingUtil.SerializeJSON=json
C_EncodingUtil.CompressString=function(s) lastJSON=s;return compress(s) end
callbacks={}
function CreateFrame()return {RegisterEvent=function()end,SetScript=function(_,_,fn)callbacks[#callbacks+1]=fn end}end
function fire(event)for _,fn in ipairs(callbacks)do fn(nil,event)end end
function UnitName()return 'Mage' end
open=true;loaded=3;total=8;retrieved=false;reads=0;forbidden=0
MailFrame={IsShown=function()return open end}
function GetInboxNumItems()return loaded,total end
function GetInboxHeaderInfo(i)
 local expiry=i*2;if i==3 then expiry=nil end
 return nil,nil,'PRIVATE_SENDER','PRIVATE_SUBJECT',i==2 and 12345 or 0,i==3 and 500 or 0,expiry,retrieved and i==1 and 0 or 1,nil,nil,nil,nil,nil,nil,'|Hitem:2589::::::::|h[Cloth]|h'
end
function HasInboxItem(i,slot)return slot==1 and not(retrieved and i==1)end
function GetInboxItem(i,slot)reads=reads+1;return 'Cloth',2589,nil,i*5,nil,nil,false end
for _,name in ipairs({'GetInboxText','CheckInbox','TakeInboxItem','AutoLootMailItem','TakeInboxMoney','DeleteInboxItem','ReturnInboxItem','SendMail','GetInboxInvoiceInfo','InboxFrame_OnClick','OpenMailFrame_OnShow'})do
 _G[name]=function()forbidden=forbidden+1;error('forbidden API '..name)end
end
saved={}
local save=C_AddOns.SaveAddOns
C_AddOns.SaveAddOns=function()
 save();local bytes={}
 for byte=0,95 do local value=0
  for bit=0,7 do if states[string.format('WispAI_S%04d',257+byte*8+bit)]then value=value+2^bit end end
  bytes[#bytes+1]=string.char(value)
 end
 saved[#saved+1]=table.concat(bytes)
end
`);
  for (const name of [
    'Namespace.lua',
    'Shared/Numbers.lua',
    'Shared/Text.lua',
    'Character/Mail.lua',
    'Character/Inspect.lua',
    'Transport/Transport.lua',
  ]) {
    run(
      `assert(load(${JSON.stringify(readFileSync('addon/WispAI/' + name, 'utf8'))}))('WispAI',ns)`,
    );
  }
  run('ns.Transport.StartTransport()');
  return {
    run,
    close: () => lua.lua_close(L),
    inspect: (limit = 10) => {
      run(
        `result=ns.Character.Inspect({kind='mail',args={limit=${limit}}});resultJSON=C_EncodingUtil.SerializeJSON(result)`,
      );
      return JSON.parse(string('resultJSON').toString());
    },
    send: (chat = 'chat', requestId = 'request') => {
      run(
        `saved={};ns.Transport.Send({type='state_result',chat=${JSON.stringify(chat)},requestId=${JSON.stringify(requestId)},data=result})`,
      );
      const json = string('lastJSON');
      const frames: Buffer[] = [];
      const decoder = new MailboxDecoder(UPLINK_KIND);
      let assembled;
      // One explicit packet, not the broad transport stress campaign.
      const bound = Math.ceil(deflateSync(json).length / 80) + 2;
      for (let i = 0; i < bound; i++) {
        run('now=now+.04;timers[.04]();savedFrame=saved[#saved]');
        const bytes = string('savedFrame');
        const frame = decodeFrame(bytes);
        if (!frame) throw Error('invalid production frame');
        if (i === 0 && !(frame.flags & FIRST)) throw Error('missing first frame');
        frames.push(frame.payload);
        assembled = decoder.add(bytes);
        if (frame.flags & LAST) break;
      }
      run('assert(forbidden==0)');
      if (!assembled) throw Error('production mailbox decoder rejected message');
      const decoded = inflateMessage(assembled);
      if (!decoded.equals(json)) throw Error('escaped JSON framing mismatch');
      const packet = JSON.parse(decoded.toString());
      packetSchema.parse(packet);
      return {
        packet,
        jsonBytes: json.length,
        frames: frames.length,
        compressedBytes: Buffer.concat(frames).length,
      };
    },
  };
}

import ApiConnections from '../components/connections/ApiConnections';
import ChatGptConnection from '../components/connections/ChatGptConnection';
import DefaultModelSettings from '../components/connections/DefaultModelSettings';

export default function Connections() {
  return (
    <>
      <ChatGptConnection />
      <ApiConnections />
      <DefaultModelSettings />
    </>
  );
}

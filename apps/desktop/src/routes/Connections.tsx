import ApiConnections from '../components/connections/ApiConnections';
import ChatGptConnection from '../components/connections/ChatGptConnection';
import DefaultModelSettings from '../components/connections/DefaultModelSettings';
import SearchConnection from '../components/connections/SearchConnection';

export default function Connections() {
  return (
    <>
      <ChatGptConnection />
      <ApiConnections />
      <SearchConnection />
      <DefaultModelSettings />
    </>
  );
}

const fs = require('fs');
const csv = require('csv-parser');
const sqlite3 = require('better-sqlite3');
const dotenv = require('dotenv');
const express = require('express');
const app=express();
dotenv.config();
const port = process.env.PORT||3008;

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ChannelType,
  PermissionsBitField,
  AttachmentBuilder,
} = require('discord.js');

// Define intents using GatewayIntentBits
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});
const db = new sqlite3('./database.db');

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  setupDatabase();
});

// Initialize database
const setupDatabase = () => {
  db.prepare(
    'CREATE TABLE IF NOT EXISTS users (ID INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT, Name TEXT, Enrollment TEXT, Phone TEXT, Email TEXT, Discord TEXT)'
  ).run();
  db.prepare(
    'CREATE TABLE IF NOT EXISTS newUsers (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, Enrollment TEXT, Phone TEXT, Email TEXT, Discord TEXT)'
  ).run();
  db.prepare(
    'CREATE TABLE IF NOT EXISTS groups (group_id TEXT PRIMARY KEY, number_of_members INTEGER)'
  ).run();
  preloadGroups();
  preloadUserData();
};

// Preload groups from CSV into the database
const preloadGroups = () => {
  const groups = {};
  fs.createReadStream('./mentorship_data.csv')
    .pipe(csv())
    .on('data', (data) => {
      if (!groups[data.Group]) {
        groups[data.Group] = 1;
      } else {
        groups[data.Group]++;
      }
    })
    .on('end', () => {
      const batch = db.transaction((groupData) => {
        for (const [Group, count] of Object.entries(groupData)) {
          db.prepare(
            'INSERT OR IGNORE INTO groups (group_id, number_of_members) VALUES (?, ?)'
          ).run(Group, count);
        }
      });
      batch(groups);
      console.log('Groups loaded into database');
    });
};

const preloadUserData = () => {
  const users = [];
  fs.createReadStream('./mentorship_data.csv')
    .pipe(csv())
    .on('data', (data) => users.push(data))
    .on('end', () => {
      const checkUserExists = db.prepare(
        'SELECT * FROM users WHERE Enrollment = ?'
      );
      const insert = db.prepare(
        'INSERT INTO users (group_id, Name, Enrollment, Phone, Email, Discord) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const batch = db.transaction((users) => {
        for (const user of users) {
          const existingUser = checkUserExists.get(
            user.Enrollment.toUpperCase()
          );
          if (!existingUser) {
            insert.run(
              user.Group,
              user.Name,
              user.Enrollment.toUpperCase(),
              user.Phone,
              '',
              ''
            );
          }
        }
      });
      batch(users);
      console.log('User data loaded into database');
    });
};

const activeUsers = new Set();

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const userId = message.author.id;
  const commands = [
    '!join_lwd',
    '!list_new_reg',
    '!assign_group',
    '!deassign_group',
    '!delete_entry',
  ];
  const command = message.content.trim().toLowerCase();

  if (commands.includes(command)) {
    if (activeUsers.has(userId)) {
      message.channel.send(
        "You're already running a command. Please wait until it's completed."
      );
      return;
    }
    activeUsers.add(userId);
  }

  try {
    if (command === '!join_lwd' && message.channel.name === 'welcome-to-lwd') {
      message.channel
        .send('🚀 Check your DMs for verification steps! 🛡️')
        .catch(console.error);
      const dmChannel =
        (await message.author.dmChannel) || (await message.author.createDM());
      try {
        await dmChannel.send(
          `Hello! 👋 I'm Mr. DCC Bot! 🤖\nLet\'s get started with your verification process. Please check the instructions below carefully. 📝\n\n`
        );
      } catch (error) {
        console.error('Error handling DM:', error);
        message.channel.send(
          `@${message.author.username}, I could not send you a DM 🥲. Please make sure your DMs are open and try again.`
        );
      }
      const enrollmentRegex = /^[a-zA-Z0-9]+$/;
      let valid = false;
      let enrollment;
      while (!valid) {
        enrollment = await getUserInput(
          message,
          dmChannel,
          enrollmentRegex,
          'enrollment number'
        );
        if (!enrollment) {
          await dmChannel.send('no input provided! Exiting...');
          activeUsers.delete(userId);
          return;
        }
        enrollment = enrollment.toUpperCase();
        valid = await yesNoButton(
          message,
          dmChannel,
          `You entered \`${enrollment}\`. Is this correct?`
        );
        if (!valid) {
          await dmChannel.send('🔄 Starting over...');
        }
      }
      if (!valid) {
        activeUsers.delete(userId);
        return;
      }

      // Fetch user data
      const userData = db
        .prepare('SELECT * FROM users WHERE Enrollment = ?')
        .get(enrollment);
      const newUserData = db
        .prepare('SELECT * FROM newUsers WHERE Enrollment = ?')
        .get(enrollment);

      const userDiscord_id = JSON.stringify(userData?.Discord)?.id;

      if (newUserData) {
        dmChannel.send(
          'You have already registered with us. Please wait for the admin to assign you to a group. 🕒\n our ADMINs are working tirelessly we hope you would understand'
        );
      } else if (userData && !userDiscord_id) {
        const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/;
        let email = await getUserInput(message, dmChannel, emailRegex, 'email');
        if (!email) {
          await dmChannel.send('no input provided! Exiting...');
          activeUsers.delete(userId);
          return;
        }

        const discordUser = JSON.stringify(message.author);

        db.prepare(
          'UPDATE users SET Email = ?, Discord = ? WHERE Enrollment = ?'
        ).run(email, discordUser, enrollment);
        handleRoleAndChannelAssignment(
          dmChannel,
          message.author,
          userData.group_id
        );
      } else if (userData && userDiscord_id === message.author.id) {
        dmChannel.send(
          'You are already assigned to a group and your role is set. If you need any help, please reach out to the admins. 👨‍💼👩‍💼'
        );
      } else if (userData && userDiscord_id !== message.author.id) {
        dmChannel.send(
          'Oops! 🚨 It looks like this enrollment number is already linked to another Discord account. If this seems like a mistake, please contact our admin team. 🛠️'
        );
      } else {
        dmChannel.send('It looks like you are not in our records!');
        const wantToRegister = await yesNoButton(
          message,
          dmChannel,
          'Do you want to register with 🧑‍🏫 Learn With DCC?'
        );
        if (wantToRegister) {
          dmChannel.send(
            `🧐 Let's get you registered! Please follow the next steps carefully.`
          );
          let name = await getUserInput(
            message,
            dmChannel,
            /^[a-zA-Z ]+$/,
            'full name 🧑‍🦰'
          );
          if (!name) {
            await dmChannel.send('no input provided! Exiting...');
            activeUsers.delete(userId);
            return;
          }

          const phoneRegex = /^\d{10}$/;
          let phone = await getUserInput(
            message,
            dmChannel,
            phoneRegex,
            '10-digit phone number 📱'
          );
          if (!phone) {
            await dmChannel.send('no input provided! Exiting...');
            activeUsers.delete(userId);
            return;
          }

          const emailRegex =
            /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/; // Email validation regex
          let email = await getUserInput(
            message,
            dmChannel,
            emailRegex,
            'email 📧'
          );
          if (!email) {
            await dmChannel.send('no input provided! Exiting...');
            activeUsers.delete(userId);
            return;
          }

          const messageAuthor = JSON.stringify(message.author);
          db.prepare(
            'INSERT INTO newUsers (Name, Enrollment, Phone, Email, Discord) VALUES (?, ?, ?, ?, ?)'
          ).run(name, enrollment, phone, email, messageAuthor);
          // handleRoleAndChannelAssignment(dmChannel, message.author, newGroup);
          dmChannel.send(
            `Thank you for registering! 🎉 Your details have been recorded. Please wait for the admin to assign you to a group. 🕒`
          );

          const guild = client.guilds.cache.get(process.env.GUILD_ID);
          const logChannel = guild.channels.cache.find(
            (channel) =>
              channel.name === 'mr-dcc-logs' &&
              channel.type === ChannelType.GuildText
          );
          if (logChannel) {
            logChannel.send(
              `🆕 New user registered: \`${name}\` with enrollment number \`${enrollment}\` and email \`${email}\`.`
            );
          }
        } else {
          dmChannel.send(
            `👋 BYE ... If you change your mind, feel free to reach out to us anytime.`
          );
        }
      }
    } else if (
      /*
       * list new registered users
       */
      command === '!list_new_reg' &&
      message.channel.name === 'admin-mentorship'
    ) {
      message.channel.send('the new users who are trying to join DCC are:');
      const newUsers = db.prepare('SELECT * FROM newUsers').all();
      // parse the whole newUsers into a table format and send it to the channel
      let table = '```';
      table += 'ID\tName\tEnrollment\tPhone\tEmail\n';
      newUsers.forEach((user) => {
        table += `${user.ID}\t${user.Name}\t${user.Enrollment}\t${user.Phone}\t${user.Email}\n`;
      });
      table += '```';
      message.channel.send(table);
    } else if (
      /*
       * assign group to the new users
       * - get the list of IDs
       * - get the group name
       * - assign the group to the users
       */
      command === '!assign_group' &&
      message.channel.name === 'admin-mentorship'
    ) {
      message.channel.send(
        'Now we will proceed to assign the new users to the groups'
      );

      const idList = await getUserInput(
        message,
        message.channel,
        /^[0-9,]+$/,
        'ID list separated by commas'
      );
      if (!idList) {
        message.channel.send('No IDs provided. Exiting...');
        activeUsers.delete(userId);
        return;
      }

      const group = await getUserInput(
        message,
        message.channel,
        /^[a-zA-Z0-9]+$/,
        'group'
      );
      if (!group) {
        message.channel.send('No group provided. Exiting...');
        activeUsers.delete(userId);
        return;
      }

      const idArray = idList.split(',');
      idArray.forEach((id, index) => {
        setTimeout(() => {
          const userData = db
            .prepare('SELECT * FROM newUsers WHERE ID = ?')
            .get(id);
          if (userData) {
            const discordUser = JSON.parse(userData.Discord);
            handleRoleAndChannelAssignment(message.channel, discordUser, group);
            db.prepare(
              'INSERT INTO users (group_id, Name, Enrollment, Phone, Email, Discord) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(
              group,
              userData.Name,
              userData.Enrollment,
              userData.Phone,
              userData.Email,
              userData.Discord
            );
            db.prepare('DELETE FROM newUsers WHERE ID = ?').run(id);
            message.channel.send(
              `User with ID \`${id}\` has been assigned to group \`${group}\``
            );
          } else {
            if (id !== undefined)
              message.channel.send(
                `User with ID \`${id}\` not found in the database.`
              );
          }
        }, index * 1000);
      });
    } else if (
      command === '!deassign_group' &&
      message.channel.name === 'admin-mentorship'
    ) {
      message.channel.send(
        'Now we will proceed with de-assigning the users from the groups'
      );
      const enrollment = await getUserInput(
        message,
        message.channel,
        /^[a-zA-Z0-9]+$/,
        'enrollment number'
      );
      if (!enrollment) {
        message.channel.send('No enrollment number provided. Exiting...');
        activeUsers.delete(userId);
        return;
      }
      const userData = db
        .prepare('SELECT * FROM users WHERE Enrollment = ?')
        .get(enrollment);

      if (userData) {
        if (!userData.Discord) {
          message.channel.send(
            `User with Enrollment \`${enrollment}\` does not have a Discord account linked.`
          );
          activeUsers.delete(userId);
          return;
        }
        const discordUser = JSON.parse(userData.Discord);
        console.log(userData.group_id);
        handleRoleAndChannelDeAssignment(
          message.channel,
          discordUser,
          userData.group_id,
          enrollment
        );
        message.channel.send(
          `User with Enrollment \`${enrollment}\` has been deassigned from group \`${userData.group_id}\``
        );
      }
    } else if (
      command === '!delete_entry' &&
      message.channel.name === 'admin-mentorship'
    ) {
      const idList = await getUserInput(
        message,
        message.channel,
        /^[0-9]+$/,
        'ID list, separated by commas'
      );
      if (!idList) {
        message.channel.send('No IDs provided. Exiting...');
        activeUsers.delete(userId);
        return;
      }
      const idArray = idList.split(',');
      idArray.forEach((id, _) => {
        const userData = db
          .prepare('SELECT * FROM newUsers WHERE ID = ?')
          .get(id);
        if (userData) {
          db.prepare('DELETE FROM newUsers WHERE ID = ?').run(id);
          message.channel.send(
            `User with Enrollment \`${userData.Enrollment}\` has been deleted from the new users list`
          );
        } else {
          message.channel.send(
            `User with Enrollment \`${userData.Enrollment}\` not found in the new users list. Make sure you de-assigned the user already. If not please de-assign the user first using \`!deassign_group\`.`
          );
        }
      });
    } else if(command === '!member_list_lwd'){
      const categoryId =process.env.LWD_CATEGORY_ID; 
        if (message.channel.parentId !== categoryId) {
          return ;
          
        }
      let table = '```';
      table += 'username\tName\n';
      
        const members = await getMembersWithRolePermissionsInChannel(message.guild, message.channel.id);
          members.forEach(member=>{
            if(member.name!=null){
            table += `${member.username}\t${member.name}\n`;
          }
        else{
          table += `${member.username}\t - \n`;
        }})
          table += '```';
    message.channel.send(`The List of Members in ${message.channel.name}:`);
    message.channel.send(table);
    } else {
      return;
    }

    // Remove the user from the active set once the command is done
    activeUsers.delete(userId);
  } catch (error) {
    console.error('Error handling command:', error);
    message.channel.send('An error occurred while processing your command.');
    activeUsers.delete(userId);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content === 'ping') {
    message.channel.send('pong');
  }

  // if (message.content.trim().toLowerCase() === 'cutie') {
  //   message.channel.send('A fresh cutie coming through! 🥰');
  //   message.channel.send('https://s9.gifyu.com/images/SZozs.gif');
  // }

  // if (message.content.trim().toLowerCase() === 'ok') {
  //   message.channel.send('OK 🫠');
  //   message.channel.send(
  //     'https://cdn.discordapp.com/attachments/1231682621252042812/1232422515704336485/image0.jpg?ex=66296669&is=662814e9&hm=e313fb3dfdea82574267ad87cd72c4004bfaa04136e8a2ff17875ad0944ae571&'
  //   );
  // }

  if (message.content === '!help') {
    message.channel.send(
      'Commands:\n`!help` - Display this help message \n`!join_lwd` - Join the LWD Discord server\n`!list_new_reg` - List the new users who are trying to join DCC\n`!assign_group` - Assign the new users to the groups'
    );
  }
});
async function getMembersWithRolePermissionsInChannel(guild, channelId){
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
      throw new Error(`Channel with ID ${channelId} not found`);
  }
  const membersSet = new Set();
  channel.guild.roles.cache.filter(role => {
      const permissions = channel.permissionsFor(role);
      return permissions && permissions.has(PermissionFlagsBits.ViewChannel);
       
  }).forEach(role => {
    role.members.forEach(member => {
        if(member.user.bot===false)
        membersSet.add(member);
    });
});
const members = Array.from(membersSet).map(member => ({
    id: member.id,
    username: member.user.username,
    name: member.user.globalName
    
}));
return members;
}
async function getUserInput(message, channel, regex, fieldName) {
  const filter = (m) => m.author.id === message.author.id;
  let valid = false,
    timeUp = false,
    userInput;
  while (!valid) {
    try {
      await channel.send(`Please enter your ${fieldName}:`);
      const response = await channel.awaitMessages({
        filter,
        max: 1,
        time: 60000,
        errors: ['time'],
      });
      userInput = response.first().content.trim();
      if (regex.test(userInput)) {
        valid = true;
      } else {
        channel.send(
          `🚫 Invalid input. Please ensure you enter a valid ${fieldName}.`
        );
      }
    } catch {
      if (timeUp) {
        channel.send(
          `⏰ Time's up! Due to No response! Please start the process again.`
        );
        break;
      }
      channel.send(
        `⏰ Time's up! Please try again and respond within 1 minute.`
      );
      timeUp = true;
      continue;
    }
  }
  return userInput;
}

async function yesNoButton(message, channel, question) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('yes')
      .setLabel('Yes ✔️')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('no')
      .setLabel('No ✖️')
      .setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content: question,
    components: [row],
  });

  const buttonFilter = (i) => {
    i.deferUpdate();
    return i.user.id === message.author.id;
  };

  try {
    const buttonResponse = await channel.awaitMessageComponent({
      filter: buttonFilter,
      componentType: ComponentType.Button,
      time: 60000,
      errors: ['time'],
    });

    if (buttonResponse.customId === 'yes') {
      return true;
    }
    return false;
  } catch (error) {
    await channel.send(
      'Failed to process your button click. 🚫 Please try again or contact support if the issue persists. 🆘'
    );
  }
}

async function handleRoleAndChannelAssignment(channel, user, groupName) {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  const groupName2 = "LWD - GR "+groupName;
  console.log("LWD - GR",groupName2);
  let role = guild.roles.cache.find((role) => role.name === groupName2);

  if (!role) {
    console.log('Mentee role does not exist, creating one...');
    role = await guild.roles.create({
      name: groupName2,
      color: '#FF5733',
      permissions: [],
    });
  }

  // Find or create the category
  // let category = guild.channels.cache.find(
  //   (c) =>
  //     c.name === `Group ${groupName}` && c.type === ChannelType.GuildCategory
  // );
  // if (!category) {
  //   console.log(`Creating new category and channels for group ${groupName}`);
  //   category = await guild.channels.create({
  //     name: `Group ${groupName}`,
  //     type: ChannelType.GuildCategory,
  //     permissionOverwrites: [
  //       {
  //         id: guild.id,
  //         deny: [PermissionsBitField.Flags.ViewChannel],
  //       },
  //       {
  //         id: role.id,
  //         deny: [PermissionsBitField.Flags.ViewChannel],
  //       },
  //     ],
  //   });

    // Create channels for category
    // await createOrUpdateChannel(
    //   guild,
    //   category,
    //   'announcements',
    //   'Group announcements and important info'
    // );
    // await createOrUpdateChannel(
    //   guild,
    //   category,
    //   'general-chat',
    //   'General discussion for the group'
    // );
    // await createOrUpdateChannel(
    //   guild,
    //   category,
    //   'voice-chat',
    //   '',
    //   ChannelType.GuildVoice
    // );
  // }
//
  // Ensure the user has the Mentee role
  const member = await guild.members.fetch(user.id);
  // Update existing channels
  // await ensureUserAccess(guild, category, user);
  // console.log("role:",role);
  await member.roles.add(role);

  channel.send(
    `Verification successful! ✅ Now you have access to exclusive channels in \`#Group ${groupName}\`. Enjoy your journey with us! 🌟`
  );
  console.log(
    `Assigned '${groupName2}' role and access to 'Group ${groupName}' channel for user ${user.username}`
  );
  const logChannel = guild.channels.cache.find(
    (channel) =>
      channel.name === 'mr-dcc-logs' && channel.type === ChannelType.GuildText
  );
  if (logChannel) {
    logChannel.send(
      `✅ Assigned \`'${groupName2}'\` role and access to \`#Group ${groupName}\` channel for user \`@${user.username}\``
    );
  } else {
    console.log("Couldn't find the #mentorship-logs channel.");
  }
}

async function handleRoleAndChannelDeAssignment(
  channel,
  user,
  groupName,
  enrollment
) {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);

  try {
    const member = await guild.members.fetch(user.id);
    let role = guild.roles.cache.find((role) => role.name === 'Mentee');
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
    }
    channel.send(`Mentee role has been removed from the user <@${user.id}>`);
  } catch (error) {
    channel.send(`Unable to remove role Mentee form <@${user.id}>`);
  }
  try {
    let category = guild.channels.cache.find(
      (c) =>
        c.name === `Group ${groupName}` && c.type === ChannelType.GuildCategory
    );
    if (category) {
      await removeUserAccess(guild, category, user);
    } else {
      channel.send(`Unable to remove user <@${user.id}> from the group`);
    }

    channel.send(
      `User <@${user.id}> has been removed from the group ${groupName}`
    );
  } catch (error) {
    channel.send(
      `Unable to remove user <@${user.id}> from the group ${groupName}`
    );
  }
  try {
    // remove user form the user table and insert into the newUser table
    const userData = db
      .prepare('SELECT * FROM users WHERE Enrollment = ?')
      .get(enrollment);
    db.prepare(
      'INSERT INTO newUsers (Name, Enrollment, Phone, Email, Discord) VALUES (?, ?, ?, ?, ?)'
    ).run(
      userData.Name,
      userData.Enrollment,
      userData.Phone,
      userData.Email,
      userData.Discord
    );
    db.prepare('DELETE FROM users WHERE Enrollment = ?').run(enrollment);
  } catch (error) {
    channel.send(
      `there has been some error in database update please fix it ASAP!!!`
    );
    console.log(error);
  }
  const logChannel = guild.channels.cache.find(
    (channel) =>
      channel.name === 'mr-dcc-logs' && channel.type === ChannelType.GuildText
  );
  if (logChannel) {
    logChannel.send(
      `User has been removed from the group ${groupName} and the role Mentee has been removed`
    );
  }
}

async function createOrUpdateChannel(
  guild,
  category,
  channelName,
  topic,
  type = ChannelType.GuildText
) {
  let channel = guild.channels.cache.find(
    (c) => c.name === channelName && c.parentId === category.id
  );
  if (!channel) {
    console.log(`Creating new channel: ${channelName}`);
    channel = await guild.channels.create({
      name: channelName,
      type: type,
      parent: category.id,
      topic: topic,
    });
  }
}

async function ensureUserAccess(guild, category, user) {
  const channels = guild.channels.cache.filter(
    (c) => c.parentId === category.id
  );
  channels.forEach(async (channel) => {
    const permission = channel.permissionOverwrites.cache.get(user.id);
    if (!permission) {
      await channel.permissionOverwrites.create(user.id, {
        ViewChannel: true,
      });
      console.log(`Added permissions for ${channel.name}`);
    }
  });
}

async function removeUserAccess(guild, catagory, user) {
  const channels = guild.channels.cache.filter(
    (c) => c.parentId === catagory.id
  );
  channels.forEach(async (channel) => {
    const permission = channel.permissionOverwrites.cache.get(user.id);
    if (permission) {
      await channel.permissionOverwrites.create(user.id, {
        ViewChannel: false,
      });
      console.log(`Removing permission for ${channel.name}`);
    }
  });
}

/*
 * function to generate new group id with some sexy logic
 * @returns {String} new group id
 */

// const getNewUserGroup = () => {
//   try {
//     const lastGroup = db
//       .prepare('SELECT * FROM groups ORDER BY group_id DESC LIMIT 1')
//       .get();
//     if (lastGroup) {
//       if (lastGroup.number_of_members < 10) {
//         db.prepare(
//           'UPDATE groups SET number_of_members = number_of_members + 1 WHERE group_id = ?'
//         ).run(lastGroup.group_id);
//         return lastGroup.group_id;
//       } else {
//         const prefix = lastGroup.group_id.charAt(0);
//         const number = parseInt(lastGroup.group_id.substring(1));
//         let newGroupId;
//         if (number < 5) {
//           newGroupId = `${prefix}${number + 1}`;
//         } else {
//           newGroupId = String.fromCharCode(prefix.charCodeAt(0) + 1) + '1';
//         }
//         db.prepare(
//           'INSERT INTO groups (group_id, number_of_members) VALUES (?, 1)'
//         ).run(newGroupId);
//         return newGroupId;
//       }
//     }
//   } catch (error) {
//     console.error('Error fetching group data:', error);
//     return 'TEMP';
//   }
// };

client.login(process.env.DISCORD_TOKEN);
app.get('/', (req, res) => {
  res.status(200).send('Bot is running');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});